const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactValue, secretValues, REDACTED } = require('../../utils/redact');

test('replaces exact secret env values', () => {
  const secrets = secretValues(['MY_KEY', 'SHORT'], { MY_KEY: 'super-secret-value-123', SHORT: 'abc' });
  assert.deepEqual(secrets, ['super-secret-value-123']);
  assert.equal(redactText('key=super-secret-value-123 used', secrets), `key=${REDACTED} used`);
});

test('treats *_KEY/*_TOKEN/*_SECRET env names as secrets', () => {
  const secrets = secretValues([], { MINIMAX_TEXT_API_KEY: 'value-from-name-pattern', YOUTUBE_REGION: 'IN-region-code' });
  assert.deepEqual(secrets, ['value-from-name-pattern']);
});

test('masks well-known token shapes', () => {
  const samples = [
    'Authorization: Bearer abcdefghijklmnop',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    `AIza${'A'.repeat(35)}`,
    'ya29.a0AfH6SMBabcdefghijklmnopqrst',
    `123456789:${'a'.repeat(35)}`,
    `ghp_${'a'.repeat(36)}`,
    'AKIAABCDEFGHIJKLMNOP',
    'https://api.example.com/v1?key=abc123&x=1'
  ];
  for (const sample of samples) {
    const output = redactText(sample, []);
    assert.ok(output.includes(REDACTED), `not redacted: ${sample}`);
  }
  assert.equal(redactText('https://api.example.com/v1?key=abc123&x=1', []), `https://api.example.com/v1?key=${REDACTED}&x=1`);
});

test('leaves ordinary text and Kannada untouched', () => {
  const text = 'Rendered 12 scenes in 3400ms — ಕನ್ನಡ ಸಂದರ್ಶನ';
  assert.equal(redactText(text, []), text);
});

test('redacts sensitive keys deeply but keeps usage counters', () => {
  const input = {
    config: { headers: { Authorization: 'Bearer xyz12345678', 'x-api-key': 'k' } },
    tokens: { access_token: 'a', refresh_token: 'b' },
    usage: { inputTokens: 120, maxOutputTokens: 800 },
    credentialsValid: true,
    nested: [{ password: 'p' }]
  };
  const output = redactValue(input, []);
  assert.equal(output.config.headers.Authorization, REDACTED);
  assert.equal(output.config.headers['x-api-key'], REDACTED);
  assert.deepEqual(output.tokens, { access_token: REDACTED, refresh_token: REDACTED });
  assert.deepEqual(output.usage, { inputTokens: 120, maxOutputTokens: 800 });
  assert.equal(output.credentialsValid, true);
  assert.equal(output.nested[0].password, REDACTED);
  assert.equal(input.config.headers.Authorization, 'Bearer xyz12345678', 'input must not be mutated');
});

test('handles errors, cycles and buffers', () => {
  const error = new Error('failed with Bearer abcdefghijklmnop');
  error.code = 'E_TEST';
  const cyclic = { error, buffer: Buffer.from('secret') };
  cyclic.self = cyclic;
  const output = redactValue(cyclic, []);
  assert.ok(output.error.message.includes(REDACTED));
  assert.equal(output.error.code, 'E_TEST');
  assert.equal(output.self, '[Circular]');
  assert.equal(output.buffer, '[Buffer 6 bytes]');
});
