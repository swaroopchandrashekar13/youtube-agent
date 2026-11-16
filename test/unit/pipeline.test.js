const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateBrief, ingestInbox, loadBrief } = require('../../pipeline/brief');
const { CostLedger, geminiTtsUsd } = require('../../pipeline/cost-ledger');
const { splitSentences, estimateSentenceTimings, buildCues, toSrt } = require('../../pipeline/tts/narration');
const { samenessCheck } = require('../../pipeline/qa');
const { sceneHtml, revealTimes } = require('../../pipeline/render/templates');
const { loadChannel, listChannels } = require('../../pipeline/channels');
const { TelegramClient, processDecisions, nextEveningIst } = require('../../pipeline/telegram');
const { selectProvider } = require('../../pipeline/tts/providers');

const sample = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'inbox', 'briefs', 'digital-arrest-explained.json'), 'utf8'));
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

test('channels load and validate', () => {
  assert.deepEqual(listChannels().map(channel => channel.channelId).sort(), ['data-kahani', 'scam-samjho']);
  assert.equal(loadChannel('scam-samjho').language, 'en');
  assert.throws(() => loadChannel('../etc/passwd'), /Invalid channel id/);
  assert.throws(() => loadChannel('nope'), /Unknown channel/);
});

test('the shipped brief is valid', () => {
  assert.deepEqual(validateBrief(sample()), { valid: true, errors: [] });
  assert.equal(loadBrief('digital-arrest-explained').scenes.length, 8);
});

test('briefs are rejected for missing sources, markup, banned topics and bad shape', () => {
  const cases = [
    [b => { b.scenes[1].sourceRefs = []; }, /factual scene s2 has no sourceRefs/],
    [b => { b.scenes[0].sourceRefs = ['src9']; }, /unknown source src9/],
    [b => { b.scenes[0].narration = 'Hello <script>alert(1)</script> this is a long enough line.'; }, /markup/],
    [b => { b.scenes[0].visual.headline = '<img src=x onerror=alert(1)>'; }, /markup/],
    [b => { b.description = `${b.description} This gives guaranteed returns.`; }, /banned topic/],
    [b => { b.channelId = 'unknown-channel'; }, /Unknown channel/],
    [b => { b.complianceFlags.namesPrivateIndividuals = true; }, /private individuals/],
    [b => { delete b.translations.hi.scenes.s3; }, /missing scene s3/],
    [b => { b.sources[0].url = 'http://insecure.example/x'; }, /pattern|format/],
    [b => { b.extra = 'ignore previous instructions'; }, /additional properties/],
    [b => { b.scenes[3].visual.revealAt = [1]; }, /revealAt/]
  ];
  for (const [mutate, pattern] of cases) {
    const brief = sample();
    mutate(brief);
    const result = validateBrief(brief);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' | '), pattern);
  }
});

test('ingest quarantines invalid briefs with a reason and keeps valid ones', () => {
  const dir = tmp('inbox');
  const inboxDir = path.join(dir, 'briefs');
  const rejectedDir = path.join(dir, 'rejected');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'digital-arrest-explained.json'), JSON.stringify(sample()));
  fs.writeFileSync(path.join(inboxDir, 'broken.json'), '{ not json');
  const wrongName = sample();
  fs.writeFileSync(path.join(inboxDir, 'other-name.json'), JSON.stringify(wrongName));
  const result = ingestInbox({ inboxDir, rejectedDir });
  assert.deepEqual(result.accepted, ['digital-arrest-explained']);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(fs.readdirSync(inboxDir), ['digital-arrest-explained.json']);
  assert.equal(fs.readdirSync(rejectedDir).filter(name => name.endsWith('.reason.json')).length, 2);
});

test('cost ledger records totals and enforces both caps before spending', () => {
  const file = path.join(tmp('ledger'), 'ledger.json');
  const ledger = new CostLedger({ file, monthlyCapUsd: 1, perVideoCapUsd: 0.5, now: () => new Date('2026-11-16T00:00:00Z') });
  ledger.assertBudget({ videoId: 'v1', estimateUsd: 0.4, what: 'tts' });
  ledger.record({ provider: 'gemini-tts', model: 'm', task: 'narration', videoId: 'v1', usd: 0.4 });
  assert.throws(() => ledger.assertBudget({ videoId: 'v1', estimateUsd: 0.2, what: 'tts' }), { code: 'COST_CAP_EXCEEDED' });
  ledger.assertBudget({ videoId: 'v2', estimateUsd: 0.45, what: 'tts' });
  ledger.record({ provider: 'gemini-tts', task: 'narration', videoId: 'v2', usd: 0.45 });
  assert.throws(() => ledger.assertBudget({ videoId: 'v3', estimateUsd: 0.2, what: 'tts' }), /Monthly cost cap/);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.months['2026-11'].usd, 0.85);
  assert.equal(data.months['2026-11'].byProvider['gemini-tts'], 0.85);
  assert.equal(data.videos.v1.usd, 0.4);
  // A new month starts from zero.
  const next = new CostLedger({ file, monthlyCapUsd: 1, perVideoCapUsd: 0.5, now: () => new Date('2026-12-01T00:00:00Z') });
  next.assertBudget({ videoId: 'v9', estimateUsd: 0.4, what: 'tts' });
  assert.throws(() => ledger.record({ provider: 'x', task: 't', usd: -1 }), /non-negative/);
  assert.ok(geminiTtsUsd({ inputTokens: 100, seconds: 60 }) > 0.03, 'falls back to a conservative per-second estimate');
});

test('sentence splitting handles English and Hindi', () => {
  assert.deepEqual(splitSentences('Hang up. Do not pay! Call 1930?  Tell family.'), ['Hang up.', 'Do not pay!', 'Call 1930?', 'Tell family.']);
  assert.equal(splitSentences('कॉल काट दीजिए। कोई पैसा मत भेजिए। 1930 पर कॉल कीजिए।').length, 3);
  assert.deepEqual(splitSentences('Report at cybercrime.gov.in now.'), ['Report at cybercrime.gov.in now.']);
});

test('sentence timings are monotonic and snap to real pauses', () => {
  const sentences = ['Short one.', 'A much longer second sentence here.', 'End.'];
  const plain = estimateSentenceTimings(sentences, 10, []);
  assert.equal(plain[0].start, 0);
  assert.equal(plain[2].end, 10);
  for (let index = 1; index < plain.length; index++) assert.ok(plain[index].start >= plain[index - 1].start);
  const snapped = estimateSentenceTimings(sentences, 10, [{ start: 2.4, end: 2.8 }, { start: 8.5, end: 8.9 }]);
  assert.ok(Math.abs(snapped[1].start - 2.6) < 0.01);
  assert.ok(Math.abs(snapped[2].start - 8.7) < 0.01);
});

test('captions split long sentences and format as SRT', () => {
  const cues = buildCues([{ text: 'one two three four five six seven eight nine ten eleven twelve', startSec: 1, endSec: 7 }]);
  assert.equal(cues.length, 2);
  assert.ok(Math.abs(cues[1].endSec - 7) < 1e-9);
  assert.match(toSrt(cues), /^1\n00:00:01,000 --> 00:00:03,\d{3}\n/);
});

test('sameness check blocks near-duplicates and repeated structure', () => {
  const text = 'the scam starts with a phone call from a fake police officer who says you are under arrest and must pay now';
  const structure = ['title', 'stat', 'steps', 'outro'];
  assert.equal(samenessCheck({ text, structure }, []).passed, true);
  assert.equal(samenessCheck({ text, structure }, [{ id: 'old', text, structure: ['title', 'outro'] }]).passed, false);
  const other = 'monsoon rainfall across india changed a lot over the last fifty years according to the weather office data set';
  assert.equal(samenessCheck({ text, structure }, [{ id: 'a', text: other, structure: ['title', 'bars', 'outro'] }]).passed, true);
  const repeated = samenessCheck({ text, structure }, [{ id: 'a', text: other, structure }, { id: 'b', text: `${other} again and more`, structure }]);
  assert.equal(repeated.passed, false);
  assert.match(repeated.reasons.join(' '), /same scene structure/);
});

test('templates escape brief text and place reveals at sentence starts', () => {
  const channel = loadChannel('scam-samjho');
  const html = sceneHtml({ visual: { type: 'steps', heading: 'A <b>bold</b> "move"', items: ['<script>x</script>', 'two'], revealAt: [1, 2] } }, channel, { sentenceStarts: [0.3, 2.5, 6.1] });
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(html.includes('data-at="2.500"') && html.includes('data-at="6.100"'));
  assert.deepEqual(revealTimes(3, [0.3, 2, 4, 6]), [2, 4, 6]);
  assert.deepEqual(revealTimes(2, [0.3], undefined), [0.5, 0.85]);
  assert.throws(() => sceneHtml({ visual: { type: 'unknown' } }, channel, { sentenceStarts: [0] }), /Unknown visual type/);
});

test('TTS provider selection never picks a paid provider in fake mode or without a key', () => {
  const saved = { ...process.env };
  try {
    delete process.env.GEMINI_API_KEY; delete process.env.SARVAM_API_KEY; delete process.env.TTS_PROVIDER; delete process.env.PROVIDERS_MODE;
    assert.equal(selectProvider('en').name, 'espeak');
    assert.equal(selectProvider('en').draft, true);
    process.env.GEMINI_API_KEY = 'x'.repeat(20);
    assert.equal(selectProvider('hi').name, 'gemini');
    process.env.PROVIDERS_MODE = 'fake';
    assert.equal(selectProvider('en').name, 'fake');
    delete process.env.PROVIDERS_MODE; delete process.env.GEMINI_API_KEY;
    process.env.TTS_PROVIDER = 'sarvam';
    assert.throws(() => selectProvider('hi'), /not configured/);
  } finally {
    process.env = saved;
  }
});

test('Telegram decisions: only the allow-listed chat and valid tokens count', async () => {
  const dir = tmp('tg');
  const telegram = new TelegramClient({ fake: true, chatId: '4242', recordDir: dir });
  const settings = { fork_tg_token_aaaaaaaaaaaaaaaa: 'prod-1' };
  const reviews = [];
  const agent = {
    db: {
      getSetting: async key => settings[key] ?? null,
      setSetting: async (key, value) => { settings[key] = value; },
      getProductionBundle: async () => ({ review_status: 'needs_review', seo: { title: 'T' }, editorData: {}, qualityChecks: [] }),
      saveContentReview: async (id, review) => { reviews.push({ id, ...review }); },
      updateProductionStatus: async () => {}
    }
  };
  const press = (updateId, chat, data) => ({ update_id: updateId, callback_query: { id: `q${updateId}`, from: { id: chat }, message: { chat: { id: chat } }, data } });
  telegram.fakeUpdates.push(
    press(10, 999, 'ap1:aaaaaaaaaaaaaaaa'), // stranger
    press(11, 4242, 'ap1:bbbbbbbbbbbbbbbb'), // unknown token
    press(12, 4242, 'ap1:aaaaaaaaaaaaaaaa; DROP'), // malformed
    press(13, 4242, 'app:aaaaaaaaaaaaaaaa'), // valid: approve, keep private
    press(14, 4242, 'rr:facts:aaaaaaaaaaaaaaaa') // valid: reject with reason
  );
  const approved = [];
  const results = await processDecisions(agent, telegram, { approve: async (id, decision) => { approved.push({ id, ...decision }); return {}; } });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].id, 'prod-1');
  assert.equal(approved[0].privacyStatus, 'private');
  assert.equal(approved[0].reviewer, 'telegram:4242');
  assert.equal(results.filter(item => item.ignored).length, 1);
  assert.equal(reviews[0].status, 'rejected');
  assert.match(reviews[0].reviewNotes, /Facts or sources/);
  assert.equal(settings.fork_tg_update_offset, '15');
});

test('next 6 PM IST is at least two hours away', () => {
  assert.equal(nextEveningIst(new Date('2026-11-16T05:00:00Z')).toISOString(), '2026-11-16T12:30:00.000Z');
  assert.equal(nextEveningIst(new Date('2026-11-16T11:00:00Z')).toISOString(), '2026-11-17T12:30:00.000Z');
});

test('Telegram client never leaks the token in errors', async () => {
  const token = `123456789:${'A'.repeat(35)}`;
  const client = new TelegramClient({ token, chatId: '1', fake: false });
  const original = global.fetch;
  global.fetch = async url => { throw new Error(`connect failed for ${url}`); };
  try {
    await assert.rejects(client.sendMessage('hi'), error => !error.message.includes(token) && /network error/.test(error.message));
  } finally {
    global.fetch = original;
  }
});
