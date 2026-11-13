const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, isFeatureEnabled, assertFeatureEnabled } = require('../../utils/features');

test('features are off unless explicitly enabled', () => {
  for (const name of Object.values(FEATURES)) {
    assert.equal(isFeatureEnabled(name, {}), false);
    assert.equal(isFeatureEnabled(name, { [name]: 'maybe' }), false);
    assert.equal(isFeatureEnabled(name, { [name]: 'true' }), true);
    assert.throws(() => assertFeatureEnabled(name, {}), { code: 'FEATURE_DISABLED', status: 403 });
  }
});

test('disabled upstream autonomy refuses to act', async () => {
  const saved = { ...process.env };
  try {
    for (const name of Object.values(FEATURES)) delete process.env[name];

    const { AutonomousChannelOperator } = require('../../utils/autonomous-channel-operator');
    const operator = new AutonomousChannelOperator({ getActiveOperatorRun: async () => null }, {});
    await assert.rejects(operator.start({ status: 'active' }), { code: 'FEATURE_DISABLED' });

    const { PublishingSchedulingAgent } = require('../../agents/publishing-scheduling-agent');
    const publishing = new PublishingSchedulingAgent({}, {});
    await assert.rejects(publishing.applyVideoPackaging('vid', { title: 't', thumbnailPath: 'x.png' }), { code: 'FEATURE_DISABLED' });

    const { AnonymousTelemetry } = require('../../utils/anonymous-telemetry');
    process.env.ANONYMOUS_TELEMETRY_ENABLED = 'true';
    process.env.ANONYMOUS_TELEMETRY_ENDPOINT = 'https://telemetry.example';
    assert.equal(new AnonymousTelemetry({}, null).configuration().enabled, false);
  } finally {
    process.env = saved;
  }
});
