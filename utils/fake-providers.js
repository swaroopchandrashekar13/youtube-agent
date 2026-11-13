/**
 * Offline fake providers (fork addition), enabled with PROVIDERS_MODE=fake.
 *
 * Guarantees for fake mode:
 * - No paid or networked provider is constructed, even if API keys are present.
 * - Narration is real audio (ffmpeg-synthesised tone) with a duration derived
 *   from the text, so assembly, captions and QA run on real files.
 * - YouTube is an in-process fake that records every call to
 *   data/fake-youtube/ (or FAKE_YOUTUBE_DIR) and never touches the network.
 *
 * Text generation in fake mode uses upstream's template fallbacks. A
 * schema-driven fake TextProvider arrives with the Phase 3 provider layer.
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');

const WORDS_PER_SECOND = 2.5;

/** @returns {boolean} */
function isFakeMode(env = process.env) {
  return String(env.PROVIDERS_MODE || '').trim().toLowerCase() === 'fake';
}

/**
 * Seconds of fake narration for a text: speech-rate estimate, clamped so CI
 * renders stay short (FAKE_TTS_MAX_SECONDS, default 20).
 * @param {string} text
 * @returns {number}
 */
function fakeNarrationSeconds(text, env = process.env) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const max = Math.max(2, Number(env.FAKE_TTS_MAX_SECONDS) || 20);
  return Math.round(Math.min(max, Math.max(2, words / WORDS_PER_SECOND)) * 10) / 10;
}

/**
 * Writes a quiet sine tone as narration. Output format follows the extension.
 * @param {string} text
 * @param {string} outputPath
 * @returns {Promise<{ path: string, durationSec: number }>}
 */
async function synthesizeFakeNarration(text, outputPath) {
  const durationSec = fakeNarrationSeconds(text);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const ext = path.extname(outputPath).toLowerCase();
  const codec = ext === '.wav' ? ['-c:a', 'pcm_s16le'] : ext === '.m4a' || ext === '.aac' ? ['-c:a', 'aac'] : ['-c:a', 'libmp3lame', '-b:a', '64k'];
  await runFFmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=24000:duration=${durationSec}`,
    '-af', 'volume=0.08',
    '-ac', '1',
    ...codec,
    outputPath
  ]);
  return { path: outputPath, durationSec };
}

async function drain(body) {
  if (!body) return 0;
  if (Buffer.isBuffer(body) || typeof body === 'string') return Buffer.byteLength(body);
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.length;
  return bytes;
}

/**
 * In-memory + on-disk fake of the googleapis YouTube v3 client surface this
 * project uses. Unknown methods throw so new call sites are noticed.
 * @param {{ recordDir?: string }} [options]
 */
function createFakeYouTubeClient({ recordDir } = {}) {
  const dir = recordDir || process.env.FAKE_YOUTUBE_DIR || path.join(__dirname, '..', 'data', 'fake-youtube');
  const videos = new Map();
  const calls = [];

  async function record(method, payload) {
    const entry = { method, at: new Date().toISOString(), ...payload };
    calls.push(entry);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  return {
    fake: true,
    calls,
    videos: {
      insert: async ({ part, requestBody, media } = {}) => {
        const bytes = await drain(media?.body);
        if (!bytes) throw new Error('Fake YouTube: upload body was empty');
        const id = `fake_${crypto.randomBytes(6).toString('hex')}`;
        const video = { id, snippet: requestBody?.snippet || {}, status: { uploadStatus: 'processed', ...(requestBody?.status || {}) } };
        videos.set(id, video);
        await record('videos.insert', { id, part, bytes, requestBody });
        return { data: video };
      },
      list: async ({ id } = {}) => {
        const ids = String(id || '').split(',').filter(Boolean);
        return { data: { items: ids.map(videoId => videos.get(videoId) || { id: videoId, snippet: {}, status: { privacyStatus: 'private' } }) } };
      },
      update: async ({ part, requestBody } = {}) => {
        const current = videos.get(requestBody?.id) || { id: requestBody?.id };
        const next = { ...current, ...requestBody };
        videos.set(next.id, next);
        await record('videos.update', { part, requestBody });
        return { data: next };
      }
    },
    thumbnails: {
      set: async ({ videoId, media } = {}) => {
        await record('thumbnails.set', { videoId, bytes: await drain(media?.body) });
        return { data: {} };
      }
    },
    captions: {
      insert: async ({ part, requestBody, media } = {}) => {
        await record('captions.insert', { part, requestBody, bytes: await drain(media?.body) });
        return { data: { id: `fake_caption_${crypto.randomBytes(4).toString('hex')}` } };
      }
    },
    channels: {
      list: async () => ({ data: { items: [{ id: 'fake_channel', snippet: { title: 'Fake channel' }, statistics: {} }] } })
    },
    search: { list: async () => ({ data: { items: [] } }) },
    commentThreads: { list: async () => ({ data: { items: [] } }) },
    comments: {
      insert: async () => {
        throw new Error('Fake YouTube: posting comments is not supported');
      }
    }
  };
}

/** Fake YouTube Analytics v2 client: every report is empty (unavailable, never zero). */
function createFakeYouTubeAnalyticsClient() {
  return {
    fake: true,
    reports: { query: async () => ({ data: { columnHeaders: [], rows: [] } }) }
  };
}

module.exports = {
  isFakeMode,
  fakeNarrationSeconds,
  synthesizeFakeNarration,
  createFakeYouTubeClient,
  createFakeYouTubeAnalyticsClient
};
