const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../../utils/config');

test('defaults are safe', () => {
  const config = loadConfig({});
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3456);
  assert.equal(config.DEFAULT_PRIVACY_STATUS, 'private');
  assert.equal(config.PROVIDERS_MODE, 'live');
  assert.equal(config.CHANNEL_LANGUAGE, 'en');
  for (const flag of ['FEATURE_AUTONOMOUS_OPERATOR', 'FEATURE_GROWTH_EXPERIMENTS', 'FEATURE_REPLY_POSTING',
    'FEATURE_SHORTS', 'FEATURE_SCHEDULER', 'FEATURE_ANONYMOUS_TELEMETRY']) {
    assert.equal(config[flag], false, flag);
  }
  assert.ok(Object.isFrozen(config));
});

test('non-loopback HOST requires a strong API_KEY', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), error => error instanceof ConfigError && /API_KEY/.test(error.message));
  assert.throws(() => loadConfig({ HOST: '0.0.0.0', API_KEY: 'short' }), /at least 24/);
  assert.equal(loadConfig({ HOST: '0.0.0.0', API_KEY: 'x'.repeat(24) }).HOST, '0.0.0.0');
  assert.equal(loadConfig({ HOST: 'localhost' }).HOST, 'localhost');
});

test('rejects invalid values without echoing them', () => {
  const secret = 'sk-this-should-never-appear-in-errors';
  try {
    loadConfig({ PORT: secret, DEFAULT_PRIVACY_STATUS: 'everyone', FEATURE_SHORTS: 'maybe', API_KEY: 'tooshort' });
    assert.fail('expected ConfigError');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.problems.length >= 3);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('tooshort'));
  }
});

test('flags parse explicit values only', () => {
  assert.equal(loadConfig({ FEATURE_SHORTS: 'TRUE' }).FEATURE_SHORTS, true);
  assert.equal(loadConfig({ FEATURE_SHORTS: '1' }).FEATURE_SHORTS, true);
  assert.equal(loadConfig({ FEATURE_SHORTS: 'no' }).FEATURE_SHORTS, false);
  assert.equal(loadConfig({ FEATURE_SHORTS: '' }).FEATURE_SHORTS, false);
});

test('fake providers are refused in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PROVIDERS_MODE: 'fake' }), /PROVIDERS_MODE/);
  assert.equal(loadConfig({ NODE_ENV: 'test', PROVIDERS_MODE: 'fake' }).PROVIDERS_MODE, 'fake');
});

test('ALLOWED_HOSTS is split into a list', () => {
  assert.deepEqual(loadConfig({ ALLOWED_HOSTS: 'a.local, b.local,,' }).ALLOWED_HOSTS, ['a.local', 'b.local']);
});
