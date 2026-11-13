#!/usr/bin/env node
/**
 * Offline end-to-end dry run (fork addition).
 *
 *   npm run dry-run [-- --keep] [-- --out <dir>]
 *
 * Runs the real pipeline with PROVIDERS_MODE=fake in an isolated temp
 * database: generate -> quality review -> (refused publish before approval)
 * -> human approval -> publish to the YouTube fake. Verifies the MP4 with
 * ffprobe and that the upload was sent private. Prints a JSON summary.
 *
 * Exit codes: 0 ok, 1 a check failed, 30 fatal setup error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIndex = args.indexOf('--out');
const workDir = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'yt-agent-dry-run-'));
fs.mkdirSync(workDir, { recursive: true });

// Isolation: fake providers, throwaway database and fake-YouTube record, no timers.
process.env.PROVIDERS_MODE = 'fake';
process.env.DATABASE_PATH = path.join(workDir, 'dry-run.db');
process.env.FAKE_YOUTUBE_DIR = path.join(workDir, 'fake-youtube');
process.env.FEATURE_SCHEDULER = 'false';
process.env.GENERATION_RETRY_BASE_MS = '0';
if (process.env.NODE_ENV === 'production') {
  console.error('dry-run refuses to run with NODE_ENV=production');
  process.exit(30);
}

const { getFFprobePath } = require('../utils/ffmpeg');

function probe(file) {
  const output = execFileSync(getFFprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
    '-of', 'json', file
  ], { encoding: 'utf8', timeout: 30000 });
  const data = JSON.parse(output);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  return {
    durationSec: Number(Number(data.format?.duration || 0).toFixed(2)),
    video: video ? { codec: video.codec_name, width: video.width, height: video.height } : null,
    audio: audio ? { codec: audio.codec_name } : null
  };
}

async function main() {
  const { YouTubeAutomationAgent } = require('../index');
  const checks = [];
  const check = (name, passed, detail) => {
    checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
    return Boolean(passed);
  };

  const agent = new YouTubeAutomationAgent();
  if (!await agent.initialize() || agent.setupRequired) throw Object.assign(new Error('Agent failed to initialise in fake mode'), { fatal: true });

  const job = await agent.startGenerationJob({ topic: 'How to prepare for a technical interview', length: 'short' });
  await agent.waitForGenerationJob(job.id);
  const finished = await agent.db.getGenerationJob(job.id);
  check('generation completed', finished?.status === 'completed', finished?.error || finished?.status);
  const contentId = finished?.productionId || finished?.production_id;
  if (!contentId) throw new Error(`No production was created (job ${finished?.status}: ${finished?.error || 'no error'})`);

  const bundle = await agent.db.getProductionBundle(contentId);
  check('awaits human review', bundle.review_status === 'needs_review', bundle.review_status);

  const videoPath = bundle.assets?.finalVideo?.path;
  const exists = Boolean(videoPath && /\.mp4$/i.test(videoPath) && !bundle.assets.finalVideo.simulated && fs.existsSync(videoPath));
  check('final MP4 exists', exists, videoPath);
  let media = null;
  if (exists) {
    media = probe(videoPath);
    check('MP4 has a video stream', Boolean(media.video), media.video);
    check('MP4 has an audio stream', Boolean(media.audio), media.audio);
    check('MP4 duration is plausible', media.durationSec >= 5 && media.durationSec <= 120, media.durationSec);
  }

  let refusedBeforeApproval = false;
  try {
    await agent.agents.publishing.publishContent(contentId);
  } catch (error) {
    refusedBeforeApproval = ['HUMAN_APPROVAL_REQUIRED'].includes(error.code) || /not found in queue/i.test(error.message);
  }
  check('publish refused before approval', refusedBeforeApproval);

  const publishTime = new Date(Date.now() + 2 * 86400000).toISOString();
  await agent.approveContent(contentId, { factChecked: true, rightsConfirmed: true, publishTime, privacyStatus: 'public' });
  const approved = await agent.db.getProductionBundle(contentId);
  check('approval recorded', approved.review_status === 'approved' && Boolean(approved.reviewed_at));

  const published = await agent.agents.publishing.publishContent(contentId);
  const insert = agent.agents.publishing.youtube.calls.find(call => call.method === 'videos.insert');
  check('uploaded to fake YouTube', Boolean(insert?.id) && insert.bytes > 0, insert && { id: insert.id, bytes: insert.bytes });
  check('upload sent private', insert?.requestBody?.status?.privacyStatus === 'private', insert?.requestBody?.status);
  check('synthetic-content disclosure set for AI narration', insert?.requestBody?.status?.containsSyntheticMedia === true);
  check('public release is a scheduled publishAt', insert?.requestBody?.status?.publishAt === publishTime, insert?.requestBody?.status?.publishAt);

  const passed = checks.every(item => item.passed);
  const summary = {
    ok: passed,
    workDir,
    contentId,
    title: bundle.script?.title || null,
    media,
    youtubeId: published?.youtubeId || null,
    checks
  };
  if (!keep && passed) {
    summary.videoCopy = path.join(workDir, 'final.mp4');
    if (exists) fs.copyFileSync(videoPath, summary.videoCopy);
  }
  console.log(JSON.stringify(summary, null, 2));
  return passed ? 0 : 1;
}

main().then(code => process.exit(code)).catch(error => {
  console.error(JSON.stringify({ ok: false, workDir, error: error.message }, null, 2));
  process.exit(error.fatal ? 30 : 1);
});
