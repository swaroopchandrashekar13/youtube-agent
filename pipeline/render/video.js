/**
 * Video renderer (fork addition): captures scene templates frame-exactly with
 * Playwright and assembles them with ffmpeg. Frames are captured only while
 * something is animating; settled frames are held, so a two-minute video
 * needs hundreds of screenshots, not thousands. The render page has no
 * network access (CLAUDE.md rule 3).
 */
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { sceneHtml, thumbnailHtml } = require('./templates');

const FPS = 30;
const VISUAL_LEAD_SEC = 0.25; // a scene's visuals start slightly before its narration

async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
}

async function newOfflinePage(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.route('**/*', route => {
    const url = route.request().url();
    return url.startsWith('data:') || url === 'about:blank' ? route.continue() : route.abort();
  });
  return page;
}

/**
 * @param {object} input
 * @param {object} input.brief
 * @param {object} input.channel
 * @param {{ durationSec: number, scenes: {id: string, startSec: number, sentences: {startSec:number}[]}[] }} input.timeline
 * @param {string} input.workDir
 * @param {string} input.outPath silent H.264 video
 * @returns {Promise<{ frames: number, captured: number, durationSec: number }>}
 */
async function renderVisuals({ brief, channel, timeline, workDir, outPath }) {
  const framesDir = path.join(workDir, 'frames');
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  const totalFrames = Math.round(timeline.durationSec * FPS);
  const browser = await launchBrowser();
  const entries = [];
  let captured = 0;
  try {
    const page = await newOfflinePage(browser, 1920, 1080);
    for (const [index, scene] of brief.scenes.entries()) {
      const slot = timeline.scenes[index];
      const visualStart = index === 0 ? 0 : Math.max(0, slot.startSec - VISUAL_LEAD_SEC);
      const next = timeline.scenes[index + 1];
      const visualEnd = next ? Math.max(visualStart + 0.5, next.startSec - VISUAL_LEAD_SEC) : timeline.durationSec;
      const firstFrame = Math.round(visualStart * FPS);
      const lastFrame = Math.min(totalFrames, Math.round(visualEnd * FPS));
      const sentenceStarts = slot.sentences.map(sentence => Math.max(0, sentence.startSec - visualStart));

      await page.setContent(sceneHtml(scene, channel, { sentenceStarts }), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const windows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-at]')).map(el => [parseFloat(el.dataset.at), parseFloat(el.dataset.at) + parseFloat(el.dataset.dur || '0.5')]));
      const animating = t => windows.some(([start, end]) => t >= start - 1e-6 && t <= end + 1 / FPS);

      let previousAnimating = true; // forces a capture on the scene's first frame
      for (let frame = firstFrame; frame < lastFrame; frame++) {
        const t = (frame - firstFrame) / FPS;
        const active = animating(t);
        if (active || previousAnimating) {
          await page.evaluate(time => window.__seek(time), t);
          const file = path.join(framesDir, `f_${String(captured).padStart(6, '0')}.jpg`);
          await page.screenshot({ path: file, type: 'jpeg', quality: 95 });
          entries.push({ file, frames: 1 });
          captured++;
        } else {
          entries[entries.length - 1].frames += 1;
        }
        previousAnimating = active;
      }
    }
  } finally {
    await browser.close();
  }

  const list = path.join(workDir, 'frames.txt');
  const lines = [];
  for (const entry of entries) lines.push(`file '${entry.file}'`, `duration ${(entry.frames / FPS).toFixed(6)}`);
  lines.push(`file '${entries[entries.length - 1].file}'`);
  await fs.writeFile(list, lines.join('\n'));
  await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', outPath]);
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.rm(list, { force: true });
  return { frames: totalFrames, captured, durationSec: totalFrames / FPS };
}

/** Muxes a silent video with a narration track (optionally burning subtitles). */
async function muxVideo({ videoPath, audioPath, outPath, subtitlesPath = null }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-i', audioPath];
  if (subtitlesPath) {
    const escaped = subtitlesPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    args.push('-vf', `subtitles='${escaped}':force_style='FontName=Noto Sans,FontSize=13,Outline=1,Shadow=0,MarginV=12'`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', outPath);
  await runFFmpeg(args);
  return outPath;
}

async function renderThumbnail({ brief, channel, title, outPath }) {
  const browser = await launchBrowser();
  try {
    const page = await newOfflinePage(browser, 1280, 720);
    await page.setContent(thumbnailHtml({ text: brief.thumbnailText || title.split(':')[0], title, channel }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPath, type: 'png' });
  } finally {
    await browser.close();
  }
  return outPath;
}

module.exports = { renderVisuals, muxVideo, renderThumbnail, FPS };
