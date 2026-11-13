const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const {
  isFakeMode, fakeNarrationSeconds, synthesizeFakeNarration, createFakeYouTubeClient, createFakeYouTubeAnalyticsClient
} = require('../../utils/fake-providers');
const { getMediaDuration, checkFFmpeg } = require('../../utils/ffmpeg');

test('fake mode switch', () => {
  assert.equal(isFakeMode({ PROVIDERS_MODE: 'fake' }), true);
  assert.equal(isFakeMode({ PROVIDERS_MODE: 'live' }), false);
  assert.equal(isFakeMode({}), false);
});

test('narration length follows the text and is capped', () => {
  assert.equal(fakeNarrationSeconds('one two three four five', {}), 2);
  assert.equal(fakeNarrationSeconds(Array(25).fill('w').join(' '), {}), 10);
  assert.equal(fakeNarrationSeconds(Array(1000).fill('w').join(' '), {}), 20);
  assert.equal(fakeNarrationSeconds(Array(1000).fill('w').join(' '), { FAKE_TTS_MAX_SECONDS: '5' }), 5);
});

test('synthesizes real audio of the expected duration', async t => {
  if (!await checkFFmpeg()) return t.skip('ffmpeg not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tts-'));
  const out = path.join(dir, 'n.mp3');
  const result = await synthesizeFakeNarration(Array(10).fill('word').join(' '), out);
  assert.equal(result.durationSec, 4);
  const measured = await getMediaDuration(out);
  assert.ok(Math.abs(measured - 4) < 0.3, `duration ${measured}`);
});

test('fake YouTube records uploads and never posts comments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-yt-'));
  const youtube = createFakeYouTubeClient({ recordDir: dir });
  const { data } = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: { snippet: { title: 'T' }, status: { privacyStatus: 'private' } },
    media: { body: Readable.from([Buffer.from('abc'), Buffer.from('de')]) }
  });
  assert.match(data.id, /^fake_/);
  assert.equal(youtube.calls[0].bytes, 5);
  const listed = await youtube.videos.list({ id: data.id });
  assert.equal(listed.data.items[0].status.privacyStatus, 'private');
  await assert.rejects(youtube.videos.insert({ media: { body: Buffer.alloc(0) } }), /empty/);
  await assert.rejects(youtube.comments.insert({}), /not supported/);
  assert.ok(fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').includes('videos.insert'));
  const analytics = await createFakeYouTubeAnalyticsClient().reports.query({});
  assert.deepEqual(analytics.data.rows, []);
});
