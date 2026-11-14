const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EXIT, exitCodeFor, jobError } = require('../../jobs/exit-codes');
const { FileLeaseProvider } = require('../../jobs/lease');
const { generationKey, stages } = require('../../jobs/stages');
const { runJob, parseArgs } = require('../../jobs/run-job');

test('exit codes classify errors', () => {
  assert.equal(exitCodeFor(null), EXIT.OK);
  assert.equal(exitCodeFor(jobError('x', EXIT.NEEDS_HUMAN)), EXIT.NEEDS_HUMAN);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { code: 'HUMAN_APPROVAL_REQUIRED' })), EXIT.NEEDS_HUMAN);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { code: 'FEATURE_DISABLED' })), EXIT.NEEDS_HUMAN);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { code: 'ECONNRESET' })), EXIT.TRANSIENT);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { status: 429 })), EXIT.TRANSIENT);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { response: { status: 503 } })), EXIT.TRANSIENT);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { status: 400 })), EXIT.FATAL);
  assert.equal(exitCodeFor(new TypeError('bug')), EXIT.FATAL);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { name: 'ConfigError' })), EXIT.FATAL);
  assert.equal(exitCodeFor(new Error('unknown')), EXIT.FATAL, 'unknown errors must not retry forever');
});

test('argument parsing validates input', () => {
  assert.deepEqual(parseArgs(['--stage=generate', '--topic', 'Resume tips', '--length=short']),
    { stage: 'generate', topic: 'Resume tips', length: 'short' });
  assert.equal(parseArgs(['--stage=qa', '--timeout-ms=60000'])['timeout-ms'], 60000);
  for (const argv of [[], ['--stage=deploy'], ['--stage=qa', '--evil=1'], ['--stage=qa', '--content=../etc'], ['stage=qa'], ['--stage']]) {
    assert.throws(() => parseArgs(argv), error => exitCodeFor(error) === EXIT.FATAL, JSON.stringify(argv));
  }
});

test('generation keys are stable', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  assert.equal(generationKey({ brief: 'b-1', topic: 'x', now }), 'brief:b-1');
  assert.equal(generationKey({ topic: '  Resume   Tips ', now }), 'topic:resume tips');
  assert.equal(generationKey({ now }), 'daily:2026-11-14');
});

test('file lease is exclusive, renewable and recoverable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  let clock = Date.parse('2026-11-14T00:00:00Z');
  const provider = new FileLeaseProvider({ dir, now: () => clock });
  const first = await provider.acquire('pipeline', { ttlMs: 60000 });
  await assert.rejects(provider.acquire('pipeline', { ttlMs: 60000 }), { code: 'LEASE_HELD' });
  await first.renew();

  clock += 120000; // expired
  const second = await provider.acquire('pipeline', { ttlMs: 60000 });
  await assert.rejects(first.renew(), { code: 'LEASE_HELD' }, 'old owner must notice the takeover');
  await first.release(); // must not delete the new owner's lock
  await assert.rejects(provider.acquire('pipeline', { ttlMs: 60000 }), { code: 'LEASE_HELD' });
  await second.release();
  const third = await provider.acquire('pipeline', { ttlMs: 60000 });
  await third.release();
  await assert.rejects(provider.acquire('../x'), error => exitCodeFor(error) === EXIT.FATAL);
});

test('lease held by a dead process on this host is taken over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  fs.writeFileSync(path.join(dir, 'pipeline.lock'), JSON.stringify({
    id: 'dead', pid: 2 ** 22 + 12345, host: os.hostname(), expiresAt: new Date(Date.now() + 3600000).toISOString()
  }));
  const lease = await new FileLeaseProvider({ dir }).acquire('pipeline');
  await lease.release();
});

function fakeAgent(overrides = {}) {
  return {
    setupRequired: false,
    initialized: 0,
    async initialize() { this.initialized++; return true; },
    db: { db: { close() {} } },
    ...overrides
  };
}

function memoryLease() {
  let held = false;
  return {
    released: 0,
    async acquire() {
      if (held) throw jobError('held', EXIT.TRANSIENT, 'LEASE_HELD');
      held = true;
      const self = this;
      return { async renew() {}, async release() { held = false; self.released++; } };
    }
  };
}

test('runJob maps outcomes to exit codes and always releases the lease', async () => {
  const leases = memoryLease();
  const lines = [];
  const print = line => lines.push(JSON.parse(line));

  const ok = await runJob({
    argv: ['--stage=learn'], leaseProvider: leases, print,
    createAgent: () => fakeAgent({ agents: { analytics: {} }, db: { db: { close() {} }, getAllRows: async () => [] } })
  });
  assert.equal(ok.exitCode, EXIT.OK);
  assert.equal(ok.report.outcome, 'noop');
  assert.equal(leases.released, 1);

  const setup = await runJob({ argv: ['--stage=qa'], leaseProvider: leases, print, createAgent: () => fakeAgent({ setupRequired: true }) });
  assert.equal(setup.exitCode, EXIT.FATAL);
  assert.equal(setup.report.error.code, 'SETUP_REQUIRED');
  assert.equal(leases.released, 2);

  const bad = await runJob({ argv: ['--stage=nope'], leaseProvider: leases, print, createAgent: () => assert.fail('agent must not be created') });
  assert.equal(bad.exitCode, EXIT.FATAL);
  assert.equal(lines.at(-1).exitCode, EXIT.FATAL);
});

test('runJob reports a held lease as transient without creating the agent', async () => {
  const leases = memoryLease();
  await leases.acquire();
  const result = await runJob({ argv: ['--stage=publish'], leaseProvider: leases, print: () => {}, createAgent: () => assert.fail('must not run') });
  assert.equal(result.exitCode, EXIT.TRANSIENT);
  assert.equal(result.report.error.code, 'LEASE_HELD');
});

test('runJob times out as transient', async () => {
  const original = stages.publish;
  stages.publish = () => new Promise(() => {});
  try {
    const result = await runJob({ argv: ['--stage=publish', '--timeout-ms=1000'], leaseProvider: memoryLease(), print: () => {}, createAgent: () => fakeAgent() });
    assert.equal(result.exitCode, EXIT.TRANSIENT);
    assert.equal(result.report.error.code, 'JOB_TIMEOUT');
  } finally {
    stages.publish = original;
  }
});

test('runJob turns SIGTERM into a released lease and a transient exit', async () => {
  const original = stages.publish;
  let trigger;
  stages.publish = () => new Promise(() => {});
  const leases = memoryLease();
  try {
    const pending = runJob({
      argv: ['--stage=publish', '--timeout-ms=1000'], leaseProvider: leases, print: () => {}, createAgent: () => fakeAgent(),
      onTerminate: handler => { trigger = handler; return () => {}; }
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const terminated = await trigger('SIGTERM');
    assert.equal(terminated.exitCode, EXIT.TRANSIENT);
    assert.equal(leases.released, 1);
    assert.equal((await pending).exitCode, EXIT.TRANSIENT, 'the later timeout must not change the reported result');
  } finally {
    stages.publish = original;
  }
});

test('learn stage fails transiently only when every video fails', async () => {
  const videos = [{ youtube_id: 'v1' }, { youtube_id: 'v2' }];
  const agentWith = analyze => ({
    agents: { analytics: { getDueMeasurementWindows: async () => ['24h'], analyzeVideoPerformance: analyze } },
    db: { getAllRows: async () => videos }
  });
  const partial = await stages.learn(agentWith(async id => { if (id === 'v2') throw new Error('quota'); }), { delayMs: 0 });
  assert.equal(partial.outcome, 'ok');
  assert.equal(partial.summary.captured.length, 1);
  assert.equal(partial.summary.failed.length, 1);
  await assert.rejects(
    stages.learn(agentWith(async () => { throw Object.assign(new Error('down'), { status: 503 }); }), { delayMs: 0 }),
    error => exitCodeFor(error) === EXIT.TRANSIENT
  );
});

test('publish stage separates uploads from human-blocked items', async () => {
  const calls = [];
  const agent = {
    db: { updateProductionStatus: async () => {} },
    agents: {
      publishing: {
        publishQueue: [
          { productionId: 'a', status: 'scheduled' },
          { productionId: 'b', status: 'scheduled' },
          { productionId: 'c', status: 'published' }
        ],
        async loadPublishQueue() {},
        async publishContent(id) {
          calls.push(id);
          if (id === 'b') throw Object.assign(new Error('not approved'), { code: 'HUMAN_APPROVAL_REQUIRED' });
          return { status: 'published', youtubeId: 'y', publishTime: 't' };
        }
      }
    }
  };
  const result = await stages.publish(agent, {});
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.outcome, 'needs_human');
  assert.equal(result.summary.published.length, 1);
  assert.equal(result.summary.blocked[0].code, 'HUMAN_APPROVAL_REQUIRED');
});
