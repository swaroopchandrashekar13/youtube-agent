/**
 * Automated quality gates for brief-driven videos (fork addition).
 * Each check is { id, passed, blocking, detail }. Blocking failures stop the
 * video from being offered for publishing approval.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { getFFmpegPath, getMediaDuration } = require('../utils/ffmpeg');
const { TARGET_LUFS } = require('./tts/narration');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

async function ffmpegStderr(args) {
  try {
    const { stderr } = await execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
    return stderr;
  } catch (error) {
    if (error.stderr) return error.stderr;
    throw error;
  }
}

function ngrams(text, n = 3) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let index = 0; index <= words.length - n; index++) set.add(words.slice(index, index + n).join(' '));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Sameness against recent videos of the same channel: script 3-gram overlap
 * and scene-structure similarity. Template-like channels risk demonetisation.
 * @param {{ text: string, structure: string[] }} current
 * @param {{ id: string, text: string, structure: string[] }[]} previous
 */
function samenessCheck(current, previous, { maxOverlap = 0.35, maxOverlapSameStructure = 0.2, maxSameStructureInARow = 2 } = {}) {
  const grams = ngrams(current.text);
  let worst = { id: null, overlap: 0 };
  let sameStructureRun = 0;
  let counting = true;
  const reasons = [];
  for (const item of previous) {
    const overlap = jaccard(grams, ngrams(item.text));
    if (overlap > worst.overlap) worst = { id: item.id, overlap };
    const sameStructure = item.structure.join('>') === current.structure.join('>');
    if (counting && sameStructure) sameStructureRun++;
    else counting = false;
    if (overlap > maxOverlap) reasons.push(`script overlaps ${Math.round(overlap * 100)}% with ${item.id}`);
    else if (sameStructure && overlap > maxOverlapSameStructure) reasons.push(`same structure and ${Math.round(overlap * 100)}% script overlap with ${item.id}`);
  }
  if (sameStructureRun >= maxSameStructureInARow) reasons.push(`same scene structure as the last ${sameStructureRun} videos`);
  return { passed: reasons.length === 0, worst, sameStructureRun, reasons };
}

function recentProductions(channelId, excludeBriefId, limit = 10, dir = process.env.PRODUCTIONS_DIR || path.join(ROOT, 'data', 'productions')) {
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'qa-fingerprint.json');
    if (name === excludeBriefId || !fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.channelId === channelId) items.push(data);
  }
  return items.sort((a, b) => String(b.producedAt).localeCompare(String(a.producedAt))).slice(0, limit);
}

/**
 * @param {object} brief
 * @param {object} manifest from produceFromBrief
 * @returns {Promise<{ passed: boolean, score: number, checks: object[], blockingFailures: string[] }>}
 */
async function runBriefQa(brief, manifest) {
  const checks = [];
  const add = (id, passed, detail, blocking = true) => checks.push({ id, passed: Boolean(passed), blocking, detail });
  const video = manifest.files.video;

  add('video_file', fs.existsSync(video) && fs.statSync(video).size > 100000, video);
  const duration = fs.existsSync(video) ? await getMediaDuration(video) : 0;
  const target = brief.durationTargetSec;
  add('duration', duration >= target * 0.7 && duration <= target * 1.35, `${duration.toFixed(1)}s (target ${target}s, allowed ${Math.round(target * 0.7)}-${Math.round(target * 1.35)}s)`);

  const unsourced = brief.scenes.filter(scene => scene.factual && scene.sourceRefs.length === 0).map(scene => scene.id);
  add('sources', unsourced.length === 0, unsourced.length ? `factual scenes without sources: ${unsourced.join(', ')}` : `${brief.sources.length} sources cited`);

  const draft = Object.entries(manifest.narration).filter(([, track]) => track.draft).map(([language, track]) => `${language}:${track.provider}`);
  // Placeholder voices can never be published. Fake mode (offline tests, fake YouTube) is the only exception.
  const fakeMode = String(process.env.PROVIDERS_MODE).toLowerCase() === 'fake';
  add('narration_voice', draft.length === 0 || fakeMode, draft.length ? `placeholder voice (${draft.join(', ')}); configure a real TTS provider before publishing` : 'real TTS voice');

  const rushed = Object.entries(manifest.narration).filter(([, track]) => (track.maxTempo || 1) > 1.25).map(([language, track]) => `${language} x${track.maxTempo}`);
  add('dub_pace', rushed.length === 0, rushed.length ? `dub sped up too much (${rushed.join(', ')}); shorten that translation` : 'dub tracks fit at a natural pace', false);

  if (fs.existsSync(video)) {
    const stderr = await ffmpegStderr(['-hide_banner', '-nostats', '-i', video,
      '-af', 'ebur128=peak=true,silencedetect=noise=-45dB:d=2.5', '-vf', 'blackdetect=d=0.5:pix_th=0.05', '-f', 'null', '-']);
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
    const peak = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
    add('loudness', Number.isFinite(lufs) && Math.abs(lufs - TARGET_LUFS) <= 2 && (!Number.isFinite(peak) || peak <= -0.5),
      `${lufs} LUFS (target ${TARGET_LUFS} ±2), true peak ${Number.isFinite(peak) ? peak : 'n/a'} dBFS`);
    const silences = [...stderr.matchAll(/silence_duration: ([\d.]+)/g)].map(match => Number(match[1]));
    add('silence', silences.length === 0, silences.length ? `${silences.length} silent gap(s) over 2.5s (longest ${Math.max(...silences).toFixed(1)}s)` : 'no dead air over 2.5s');
    const black = [...stderr.matchAll(/black_duration:([\d.]+)/g)].map(match => Number(match[1]));
    add('black_frames', black.length === 0, black.length ? `${black.length} black segment(s)` : 'no black frames');
  }

  const srt = manifest.files.captions[brief.language]?.srt;
  let captionOk = false;
  let captionDetail = 'captions missing';
  if (srt && fs.existsSync(srt)) {
    const times = [...fs.readFileSync(srt, 'utf8').matchAll(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/g)]
      .map(m => [m[1] * 3600 + m[2] * 60 + Number(m[3]) + m[4] / 1000, m[5] * 3600 + m[6] * 60 + Number(m[7]) + m[8] / 1000]);
    const ordered = times.every(([start, end], index) => end > start && (index === 0 || start >= times[index - 1][1] - 0.05));
    const lastEnd = times.length ? times[times.length - 1][1] : 0;
    captionOk = times.length > 0 && ordered && lastEnd <= duration + 0.5 && lastEnd >= duration * 0.8;
    captionDetail = `${times.length} cues, last ends at ${lastEnd.toFixed(1)}s of ${duration.toFixed(1)}s`;
  }
  add('caption_sync', captionOk, captionDetail);

  const text = brief.scenes.map(scene => scene.narration).join(' ');
  const sameness = samenessCheck({ text, structure: manifest.structure }, recentProductions(brief.channelId, brief.briefId));
  add('sameness', sameness.passed, sameness.passed ? `max script overlap ${Math.round(sameness.worst.overlap * 100)}% with recent videos` : sameness.reasons.join('; '));

  const hook = brief.scenes[0].narration.split(/\s+/).slice(0, 40).join(' ').toLowerCase();
  add('hook', !/(welcome to|welcome back|in this video|hello (guys|friends|everyone)|namaste (dosto|friends))/.test(hook), 'first 15 seconds open on the story, not a channel intro', false);
  add('thumbnail', fs.existsSync(manifest.files.thumbnail), manifest.files.thumbnail, false);

  const blockingFailures = checks.filter(check => check.blocking && !check.passed).map(check => check.id);
  const result = { passed: blockingFailures.length === 0, score: Math.round((checks.filter(check => check.passed).length / checks.length) * 100), checks, blockingFailures };
  fs.writeFileSync(path.join(path.dirname(video), 'qa.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(path.dirname(video), 'qa-fingerprint.json'), JSON.stringify({ id: brief.briefId, channelId: brief.channelId, producedAt: manifest.producedAt, text, structure: manifest.structure }));
  return result;
}

module.exports = { runBriefQa, samenessCheck, ngrams, jaccard };
