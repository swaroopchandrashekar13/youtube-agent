const test = require('node:test');
const assert = require('node:assert/strict');

test('JSON logs are structured and redacted', async () => {
  const saved = { ...process.env };
  process.env.LOG_FORMAT = 'json';
  // Built at runtime so secret scanners do not flag the fixture.
  const fakeKey = ['sk', 'test', '0123456789abcdefghij'].join('-');
  process.env.OPENAI_API_KEY = fakeKey;
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    const callback = rest.find(item => typeof item === 'function');
    if (callback) callback();
    return true;
  };
  try {
    const { Logger } = require('../../utils/logger');
    const logger = new Logger('UnitTest');
    logger.info(`calling with ${process.env.OPENAI_API_KEY}`, { headers: { authorization: 'Bearer abcdefghijklmnop' } });
    const error = new Error(`upstream said key=${process.env.OPENAI_API_KEY}`);
    logger.error('request failed', error);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.stdout.write = write;
    process.env = saved;
  }
  const output = lines.join('');
  assert.ok(!output.includes(fakeKey), 'secret leaked');
  assert.ok(!output.includes('abcdefghijklmnop'), 'bearer leaked');
  const records = output.split('\n')
    .filter(line => line.startsWith('{') && line.includes('"component":"UnitTest"'))
    .map(line => JSON.parse(line));
  assert.ok(records.length >= 2);
  assert.equal(records[0].component, 'UnitTest');
  assert.equal(records[0].level, 'info');
  assert.ok(records[0].timestamp);
});
