#!/usr/bin/env node
/**
 * One-shot job runner (fork addition).
 *
 *   npm run job -- --stage=<ingest|generate|qa|publish|learn> [--topic="..."] [--brief=<id>]
 *                  [--content=<productionId>] [--length=short|medium|long] [--timeout-ms=N]
 *
 * Runs one stage under the single-runner lease and exits. Never starts the
 * HTTP server or the in-process scheduler. The last stdout line is a JSON
 * summary; the exit code is in jobs/exit-codes.js (0 ok, 10 needs human,
 * 20 transient, 30 fatal).
 */
const { z } = require('zod');
const { EXIT, exitCodeFor, jobError } = require('./exit-codes');
const { FileLeaseProvider } = require('./lease');
const { STAGES, stages } = require('./stages');

const ID = /^[A-Za-z0-9._-]{1,100}$/;

const argsSchema = z.object({
  stage: z.enum(STAGES),
  topic: z.string().trim().min(3).max(200).optional(),
  brief: z.string().regex(ID, 'must be letters, digits, dot, dash or underscore').optional(),
  content: z.string().regex(ID, 'must be a production id').optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
  'timeout-ms': z.coerce.number().int().min(1000).max(4 * 60 * 60 * 1000).optional()
}).strict();

/**
 * Parses `--key=value` and `--key value`.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw jobError(`Unexpected argument: ${arg}`, EXIT.FATAL, 'BAD_ARGS');
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw jobError(`Missing value for ${arg}`, EXIT.FATAL, 'BAD_ARGS');
      out[arg.slice(2)] = next;
      index++;
    }
  }
  const result = argsSchema.safeParse(out);
  if (!result.success) {
    const problems = result.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`);
    throw jobError(`Invalid arguments: ${problems.join('; ')}`, EXIT.FATAL, 'BAD_ARGS');
  }
  return result.data;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Deliberately not unref'd: the deadline must fire even if the stage is idle-waiting.
    timer = setTimeout(() => reject(jobError(`Stage exceeded its ${ms} ms timeout`, EXIT.TRANSIENT, 'JOB_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} options
 * @param {string[]} options.argv
 * @param {() => any} [options.createAgent]
 * @param {{ acquire: Function }} [options.leaseProvider]
 * @param {(line: string) => void} [options.print]
 * @param {(handler: Function) => () => void} [options.onTerminate] registers SIGTERM/SIGINT handling
 * @returns {Promise<{ exitCode: number, report: object }>}
 */
async function runJob({ argv, createAgent, leaseProvider, print = line => process.stdout.write(`${line}\n`), onTerminate } = {}) {
  const startedAt = Date.now();
  const report = { stage: null, outcome: null, exitCode: null, durationMs: null };
  let lease = null;
  let renewTimer = null;
  let agent = null;
  let detach = () => {};

  let finished = null;
  const finish = exitCode => {
    finished = finished || finalize(exitCode);
    return finished;
  };
  const finalize = async exitCode => {
    clearInterval(renewTimer);
    detach();
    await lease?.release().catch(() => {});
    lease = null;
    try {
      agent?.db?.db?.close?.();
    } catch (_error) { /* already closed */ }
    report.exitCode = exitCode;
    report.durationMs = Date.now() - startedAt;
    print(JSON.stringify(report));
    return { exitCode, report };
  };

  try {
    const args = parseArgs(argv);
    report.stage = args.stage;

    const { loadConfig } = require('../utils/config');
    const config = loadConfig(process.env);
    // Job mode never runs timers of its own.
    process.env.FEATURE_SCHEDULER = 'false';

    const timeoutMs = args['timeout-ms'] || Number(process.env.JOB_TIMEOUT_MS) || 45 * 60 * 1000;
    lease = await (leaseProvider || new FileLeaseProvider()).acquire('pipeline', { ttlMs: timeoutMs + 5 * 60 * 1000 });
    renewTimer = setInterval(() => lease?.renew().catch(() => {}), Math.max(1000, Math.floor(timeoutMs / 3)));
    renewTimer.unref?.();

    let terminated = null;
    if (onTerminate) {
      detach = onTerminate(async signal => {
        // Fargate sends SIGTERM before stopping a task: release the lease and report "transient".
        terminated = signal;
        report.outcome = 'error';
        report.error = { message: `Received ${signal}`, code: 'JOB_TERMINATED', name: 'Error' };
        return finish(EXIT.TRANSIENT);
      });
    }

    // Only create the agent once we hold the lease: initialise() marks unfinished jobs interrupted.
    const create = createAgent || (() => new (require('../index').YouTubeAutomationAgent)());
    agent = create();
    if (!await agent.initialize()) throw jobError('The agent failed to initialise', EXIT.FATAL, 'INIT_FAILED');
    if (agent.setupRequired && args.stage !== 'ingest') {
      throw jobError('Credentials are missing. Run npm run walkthrough, or set PROVIDERS_MODE=fake for an offline run', EXIT.FATAL, 'SETUP_REQUIRED');
    }

    const result = await withTimeout(stages[args.stage](agent, args, config), timeoutMs);
    if (terminated) throw jobError(`Received ${terminated}`, EXIT.TRANSIENT, 'JOB_TERMINATED');
    report.outcome = result.outcome;
    report.summary = result.summary;
    return finish(result.outcome === 'needs_human' ? EXIT.NEEDS_HUMAN : EXIT.OK);
  } catch (error) {
    const exitCode = exitCodeFor(error);
    report.outcome = 'error';
    report.error = { message: error.message, code: error.code || null, name: error.name };
    return finish(exitCode);
  }
}

if (require.main === module) {
  const onTerminate = handler => {
    const listener = signal => {
      // Hard stop if releasing the lease hangs.
      setTimeout(() => process.exit(EXIT.TRANSIENT), 5000).unref();
      Promise.resolve(handler(signal)).finally(() => process.exit(EXIT.TRANSIENT));
    };
    process.once('SIGTERM', listener);
    process.once('SIGINT', listener);
    return () => {
      process.off('SIGTERM', listener);
      process.off('SIGINT', listener);
    };
  };
  runJob({ argv: process.argv.slice(2), onTerminate }).then(({ exitCode }) => process.exit(exitCode));
}

module.exports = { runJob, parseArgs };
