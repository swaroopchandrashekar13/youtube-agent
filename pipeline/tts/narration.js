/**
 * Narration builder (fork addition).
 *
 * Synthesises one audio file per scene and language (natural prosody, few API
 * calls), caches by hash of (provider, voice, style, text), measures real
 * durations, lays every language on ONE shared timeline so dub tracks fit the
 * same video, estimates sentence timings (snapped to detected pauses) for
 * on-screen reveals and captions, and loudness-normalises the result.
 */
const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { promisify } = require('util');
const { getFFmpegPath, getMediaDuration, runFFmpeg } = require('../../utils/ffmpeg');
const { selectProvider } = require('./providers');

const execFileAsync = promisify(execFile);

const LEAD_IN_SEC = 0.4;
const SCENE_GAP_SEC = 0.45;
const TAIL_SEC = 0.9;
const DUB_TEMPO = { min: 0.92, max: 1.12 };
const MAX_MAIN_TAIL_SEC = 0.8;
const TARGET_LUFS = -14;

/** Splits narration into sentences (Latin and Devanagari punctuation). */
function splitSentences(text) {
  return String(text).replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?।])\s+(?=\S)/u)
    .map(item => item.trim()).filter(Boolean);
}

async function ffmpegStderr(args) {
  try {
    const { stderr } = await execFileAsync(getFFmpegPath(), args, { maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
    return stderr;
  } catch (error) {
    if (error.stderr) return error.stderr;
    throw error;
  }
}

/** @returns {Promise<{start:number,end:number}[]>} pauses inside the file */
async function detectSilences(wavPath, { noiseDb = -38, minSec = 0.15 } = {}) {
  const stderr = await ffmpegStderr(['-hide_banner', '-i', wavPath, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-']);
  const silences = [];
  let start = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) start = Math.max(0, Number(s[1]));
    if (e && start !== null) {
      silences.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  return silences;
}

/**
 * Sentence boundaries: proportional to character count, snapped to the nearest
 * real pause within `snapSec`.
 * @returns {{text:string,start:number,end:number}[]} times relative to the scene's speech start
 */
function estimateSentenceTimings(sentences, speechSec, silences = [], snapSec = 0.9) {
  const total = sentences.reduce((sum, item) => sum + item.length, 0) || 1;
  const boundaries = [];
  let acc = 0;
  for (const sentence of sentences.slice(0, -1)) {
    acc += sentence.length;
    boundaries.push((acc / total) * speechSec);
  }
  const pauses = silences.map(item => (item.start + item.end) / 2).filter(time => time > 0.2 && time < speechSec - 0.2);
  const used = new Set();
  let previous = 0;
  const snapped = boundaries.map(estimate => {
    let best = null;
    for (const [index, pause] of pauses.entries()) {
      if (used.has(index) || pause <= previous + 0.25) continue;
      const distance = Math.abs(pause - estimate);
      if (distance <= snapSec && (best === null || distance < Math.abs(pauses[best] - estimate))) best = index;
    }
    const time = best === null ? Math.max(estimate, previous + 0.25) : pauses[best];
    if (best !== null) used.add(best);
    previous = time;
    return time;
  });
  const edges = [0, ...snapped, speechSec];
  return sentences.map((text, index) => ({ text, start: edges[index], end: Math.max(edges[index + 1], edges[index] + 0.2) }));
}

async function synthesizeScene({ provider, text, language, voice, style, cacheDir }) {
  const key = crypto.createHash('sha256').update(JSON.stringify([provider.name, voice, style, text])).digest('hex').slice(0, 32);
  const wavPath = path.join(cacheDir, `${provider.name}_${language}_${key}.wav`);
  const metaPath = `${wavPath}.json`;
  if (fsSync.existsSync(wavPath) && fsSync.existsSync(metaPath)) {
    return { wavPath, cached: true, ...JSON.parse(await fs.readFile(metaPath, 'utf8')) };
  }
  const raw = `${wavPath}.raw.wav`;
  const result = await provider.synthesize({ text, language, voice, style, outPath: raw });
  // Trim leading/trailing silence so scene timing is driven by speech, not provider padding.
  await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse',
    '-ar', '48000', '-ac', '1', wavPath]);
  await fs.rm(raw, { force: true });
  const meta = { model: result.model || null, usage: result.usage || {} };
  await fs.writeFile(metaPath, JSON.stringify(meta));
  return { wavPath, cached: false, ...meta };
}

async function loudnormTwoPass(input, output) {
  const stderr = await ffmpegStderr(['-hide_banner', '-i', input, '-af', `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1);
  let filter = `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`;
  try {
    const m = JSON.parse(json);
    if ([m.input_i, m.input_tp, m.input_lra, m.input_thresh].every(value => Number.isFinite(Number(value)))) {
      filter += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    }
  } catch (_error) { /* fall back to single-pass */ }
  await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-af', filter, '-ar', '48000', '-ac', '1', output]);
}

function narrationText(brief, sceneId, language) {
  if (language === brief.language) return brief.scenes.find(scene => scene.id === sceneId).narration;
  return brief.translations?.[language]?.scenes?.[sceneId]?.narration || null;
}

/**
 * @param {object} input
 * @param {object} input.brief validated brief
 * @param {object} input.channel channel config
 * @param {string[]} input.languages main language first
 * @param {string} input.workDir
 * @param {import('../cost-ledger').CostLedger} input.ledger
 * @param {string} input.videoId
 * @returns {Promise<{ durationSec: number, scenes: object[], tracks: Record<string, object> }>}
 */
async function buildNarrations({ brief, channel, languages, workDir, ledger, videoId }) {
  const cacheDir = process.env.TTS_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'tts-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  const raw = {};
  for (const language of languages) {
    const provider = selectProvider(language);
    const voice = channel.voice?.[provider.name]?.[language];
    const style = provider.name === 'gemini' ? channel.narrationStyle?.[language] : undefined;
    raw[language] = { provider, voice, usd: 0, model: null, scenes: [] };
    for (const scene of brief.scenes) {
      const text = narrationText(brief, scene.id, language);
      if (!text) throw new Error(`No ${language} narration for scene ${scene.id}`);
      const estimate = provider.estimateUsd(text);
      if (estimate > 0) ledger.assertBudget({ videoId, estimateUsd: estimate, what: `${provider.name} narration (${language}, ${scene.id})` });
      const result = await synthesizeScene({ provider, text, language, voice, style, cacheDir });
      const speechSec = await getMediaDuration(result.wavPath);
      if (!(speechSec > 0.3)) throw new Error(`Narration for ${scene.id} (${language}) is empty`);
      if (!result.cached) {
        const usd = provider.usd({ usage: result.usage, seconds: speechSec });
        if (usd > 0) {
          ledger.record({ provider: `${provider.name}-tts`, model: result.model, task: 'narration', videoId, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens ?? undefined, units: text.length, usd });
          raw[language].usd += usd;
        }
      }
      raw[language].model = result.model;
      raw[language].scenes.push({ id: scene.id, text, wavPath: result.wavPath, speechSec, cached: result.cached });
    }
  }

  // One shared timeline: each scene's slot fits the main language at natural speed and every dub within tempo limits.
  const main = languages[0];
  const scenes = [];
  let cursor = LEAD_IN_SEC;
  for (const [index, scene] of brief.scenes.entries()) {
    // The main language keeps its natural pace: a longer dub may stretch the slot by at most
    // MAX_MAIN_TAIL_SEC of extra pause; beyond that the dub is sped up instead (and QA reports it).
    const mainSec = raw[main].scenes[index].speechSec;
    const wanted = Math.max(...languages.map(language => raw[language].scenes[index].speechSec / (language === main ? 1 : DUB_TEMPO.max)));
    const slot = Math.min(mainSec + MAX_MAIN_TAIL_SEC, wanted);
    scenes.push({ id: scene.id, startSec: cursor, speechSec: slot, endSec: cursor + slot + SCENE_GAP_SEC });
    cursor += slot + SCENE_GAP_SEC;
  }
  const durationSec = Number((cursor - SCENE_GAP_SEC + TAIL_SEC).toFixed(3));

  const tracks = {};
  for (const language of languages) {
    const parts = [];
    const sentenceTimeline = [];
    let maxTempo = 1;
    for (const [index, slot] of scenes.entries()) {
      const item = raw[language].scenes[index];
      const tempo = language === main ? 1 : Math.max(DUB_TEMPO.min, item.speechSec / slot.speechSec);
      maxTempo = Math.max(maxTempo, tempo);
      const fittedSec = item.speechSec / tempo;
      const lead = index === 0 ? LEAD_IN_SEC : 0;
      const total = lead + slot.speechSec + (index === scenes.length - 1 ? TAIL_SEC : SCENE_GAP_SEC);
      const part = path.join(workDir, `narr_${language}_${String(index).padStart(2, '0')}.wav`);
      const filters = [];
      if (Math.abs(tempo - 1) > 0.005) filters.push(`atempo=${tempo.toFixed(4)}`);
      if (lead) filters.push(`adelay=${Math.round(lead * 1000)}:all=1`);
      filters.push(`apad=whole_dur=${total.toFixed(3)}`);
      await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', item.wavPath, '-af', filters.join(','), '-t', total.toFixed(3), '-ar', '48000', '-ac', '1', part]);
      parts.push(part);

      const silences = (await detectSilences(item.wavPath)).map(s => ({ start: s.start / tempo, end: s.end / tempo }));
      const sentences = estimateSentenceTimings(splitSentences(item.text), fittedSec, silences);
      const speechStart = slot.startSec;
      for (const sentence of sentences) {
        sentenceTimeline.push({ sceneId: slot.id, text: sentence.text, startSec: Number((speechStart + sentence.start).toFixed(3)), endSec: Number((speechStart + sentence.end).toFixed(3)) });
      }
    }
    const list = path.join(workDir, `narr_${language}.txt`);
    await fs.writeFile(list, parts.map(part => `file '${part.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = path.join(workDir, `narration_${language}.raw.wav`);
    await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    const wavPath = path.join(workDir, `narration_${language}.wav`);
    await loudnormTwoPass(joined, wavPath);
    for (const part of [...parts, list, joined]) await fs.rm(part, { force: true });
    tracks[language] = {
      language,
      wavPath,
      provider: raw[language].provider.name,
      model: raw[language].model,
      voice: raw[language].voice || null,
      draft: raw[language].provider.draft,
      maxTempo: Number(maxTempo.toFixed(3)),
      usd: Number(raw[language].usd.toFixed(6)),
      sentences: sentenceTimeline
    };
  }

  // Reveal timing for the renderer comes from the main language.
  for (const scene of scenes) {
    scene.sentences = tracks[main].sentences.filter(item => item.sceneId === scene.id)
      .map(item => ({ text: item.text, startSec: item.startSec, endSec: item.endSec }));
  }
  return { durationSec, scenes, tracks };
}

function formatTime(sec, separator) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

/** Caption cues from sentence timings; long sentences are split into readable chunks. */
function buildCues(sentences, maxWords = 9) {
  const cues = [];
  for (const sentence of sentences) {
    const words = sentence.text.split(/\s+/);
    const chunks = [];
    const count = Math.ceil(words.length / maxWords);
    const size = Math.ceil(words.length / count);
    for (let index = 0; index < words.length; index += size) chunks.push(words.slice(index, index + size).join(' '));
    const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    let start = sentence.startSec;
    for (const chunk of chunks) {
      const end = start + ((sentence.endSec - sentence.startSec) * chunk.length) / chars;
      cues.push({ startSec: start, endSec: end, text: chunk });
      start = end;
    }
  }
  return cues;
}

function toSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${formatTime(cue.startSec, ',')} --> ${formatTime(cue.endSec, ',')}\n${cue.text}\n`).join('\n');
}

function toVtt(cues) {
  return `WEBVTT\n\n${cues.map(cue => `${formatTime(cue.startSec, '.')} --> ${formatTime(cue.endSec, '.')}\n${cue.text}\n`).join('\n')}`;
}

module.exports = { buildNarrations, splitSentences, estimateSentenceTimings, detectSilences, buildCues, toSrt, toVtt, TARGET_LUFS };
