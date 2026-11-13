const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const {
  apiKeyMatches, extractApiKey, isProtectedPath, hostnameOf, securityMiddleware
} = require('../../utils/http-security');

const KEY = 'k'.repeat(32);

async function withServer(options, run) {
  const app = express();
  app.use(securityMiddleware(options));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  app.post('/api/thing', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const request = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    await run(request, port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('apiKeyMatches is exact', () => {
  assert.equal(apiKeyMatches(KEY, KEY), true);
  assert.equal(apiKeyMatches(`${KEY}x`, KEY), false);
  assert.equal(apiKeyMatches(undefined, KEY), false);
  assert.equal(apiKeyMatches(KEY, undefined), false);
});

test('extractApiKey reads header or cookie', () => {
  const req = headers => ({ get: name => headers[name.toLowerCase()] });
  assert.equal(extractApiKey(req({ 'x-api-key': 'a' })), 'a');
  assert.equal(extractApiKey(req({ cookie: 'other=1; yaa_api_key=b%20c' })), 'b c');
  assert.equal(extractApiKey(req({})), undefined);
});

test('protected paths', () => {
  assert.equal(isProtectedPath('/api/dashboard'), true);
  assert.equal(isProtectedPath('/analytics'), true);
  assert.equal(isProtectedPath('/publish/abc'), true);
  assert.equal(isProtectedPath('/health'), false);
  assert.equal(isProtectedPath('/app.js'), false);
  assert.equal(isProtectedPath('/analyticsx'), false);
  assert.equal(hostnameOf('[::1]:3456'), '[::1]');
});

test('blocks foreign Host headers (DNS rebinding)', async () => {
  await withServer({ bindHost: '127.0.0.1' }, async (request, port) => {
    assert.equal(await request('GET', '/health', { host: `127.0.0.1:${port}` }), 200);
    assert.equal(await request('GET', '/health', { host: `localhost:${port}` }), 200);
    assert.equal(await request('GET', '/health', { host: 'evil.example' }), 403);
  });
});

test('refuses cross-origin writes, allows same-origin and non-browser', async () => {
  await withServer({ bindHost: '127.0.0.1' }, async (request, port) => {
    const host = `127.0.0.1:${port}`;
    assert.equal(await request('POST', '/api/thing', { host, origin: 'https://evil.example' }), 403);
    assert.equal(await request('POST', '/api/thing', { host, origin: 'null' }), 403);
    assert.equal(await request('POST', '/api/thing', { host, origin: `http://${host}` }), 200);
    assert.equal(await request('POST', '/api/thing', { host }), 200);
  });
});

test('API key gates reads and writes when set', async () => {
  await withServer({ bindHost: '127.0.0.1', apiKey: KEY }, async (request, port) => {
    const host = `127.0.0.1:${port}`;
    assert.equal(await request('GET', '/health', { host }), 200);
    assert.equal(await request('GET', '/api/thing', { host }), 401);
    assert.equal(await request('GET', '/api/thing', { host, 'x-api-key': 'wrong' }), 401);
    assert.equal(await request('GET', '/api/thing', { host, 'x-api-key': KEY }), 200);
    assert.equal(await request('GET', '/api/thing', { host, cookie: `yaa_api_key=${KEY}` }), 200);
    assert.equal(await request('POST', '/api/thing', { host, 'x-api-key': KEY }), 200);
  });
});
