/**
 * Brief -> finished video (fork addition). Pure production: no database and
 * no uploads. Writes everything under data/productions/<briefId>/ and returns
 * a manifest. Re-running reuses cached narration; visuals are re-rendered.
 */
const fs = require('fs').promises;
const path = require('path');
const { loadChannel } = require('./channels');
const { CostLedger } = require('./cost-ledger');
const { buildNarrations, buildCues, toSrt, toVtt } = require('./tts/narration');
const { renderVisuals, muxVideo, renderThumbnail } = require('./render/video');

const ROOT = path.join(__dirname, '..');

function chaptersFor(brief, timeline) {
  // YouTube chapters: first at 0:00, at least three, each 10 seconds or longer.
  const stamp = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const chapters = [];
  for (const [index, scene] of brief.scenes.entries()) {
    const start = index === 0 ? 0 : timeline.scenes[index].startSec;
    const label = scene.visual.heading || scene.visual.headline || scene.onScreenText || scene.id;
    if (chapters.length && start - chapters[chapters.length - 1].startSec < 10) continue;
    chapters.push({ startSec: start, text: `${stamp(start)} ${String(label).replace(/["“”]/g, '').slice(0, 60)}` });
  }
  return chapters.length >= 3 ? chapters : [];
}

/**
 * @param {object} brief validated brief
 * @param {{ outRoot?: string, ledger?: CostLedger, languages?: string[] }} [options]
 */
async function produceFromBrief(brief, options = {}) {
  const channel = loadChannel(brief.channelId);
  const ledger = options.ledger || new CostLedger();
  const videoId = `brief-${brief.briefId}`;
  const outDir = path.join(options.outRoot || process.env.PRODUCTIONS_DIR || path.join(ROOT, 'data', 'productions'), brief.briefId);
  const workDir = path.join(outDir, 'work');
  await fs.mkdir(workDir, { recursive: true });

  const dubs = (options.languages || channel.dubLanguages).filter(language => language !== brief.language && brief.translations?.[language]);
  const languages = [brief.language, ...dubs];
  const narration = await buildNarrations({ brief, channel, languages, workDir, ledger, videoId });

  const silent = path.join(workDir, 'visuals.mp4');
  const render = await renderVisuals({ brief, channel, timeline: narration, workDir, outPath: silent });

  const title = brief.titleCandidates[0];
  const captions = {};
  for (const language of languages) {
    const cues = buildCues(narration.tracks[language].sentences);
    captions[language] = { srt: path.join(outDir, `captions.${language}.srt`), vtt: path.join(outDir, `captions.${language}.vtt`), cues: cues.length };
    await fs.writeFile(captions[language].srt, toSrt(cues));
    await fs.writeFile(captions[language].vtt, toVtt(cues));
  }

  const finalVideo = path.join(outDir, 'final.mp4');
  await muxVideo({ videoPath: silent, audioPath: narration.tracks[brief.language].wavPath, outPath: finalVideo, subtitlesPath: channel.burnSubtitles ? captions[brief.language].srt : null });
  const dubVideos = {};
  for (const language of dubs) {
    dubVideos[language] = path.join(outDir, `final.${language}.mp4`);
    await muxVideo({ videoPath: silent, audioPath: narration.tracks[language].wavPath, outPath: dubVideos[language] });
  }
  const audio = {};
  for (const language of languages) {
    audio[language] = path.join(outDir, `narration.${language}.wav`);
    await fs.copyFile(narration.tracks[language].wavPath, audio[language]);
  }
  const thumbnail = await renderThumbnail({ brief, channel, title, outPath: path.join(outDir, 'thumbnail.png') });
  await fs.rm(workDir, { recursive: true, force: true });

  const chapters = chaptersFor(brief, narration);
  const sourcesBlock = brief.sources.map(source => `- ${source.title}${source.publisher ? ` (${source.publisher})` : ''}: ${source.url}`).join('\n');
  const describe = text => [text.trim(), chapters.length ? `Chapters\n${chapters.map(chapter => chapter.text).join('\n')}` : null, `Sources\n${sourcesBlock}`, 'Narration in this video is AI-generated.']
    .filter(Boolean).join('\n\n').slice(0, 4900);

  const manifest = {
    schemaVersion: 1,
    briefId: brief.briefId,
    productionId: videoId,
    channelId: channel.channelId,
    producedAt: new Date().toISOString(),
    title,
    titleCandidates: brief.titleCandidates,
    description: describe(brief.description),
    tags: brief.tags,
    language: brief.language,
    localizations: Object.fromEntries(dubs.map(language => [language, { title: brief.translations[language].title, description: describe(brief.translations[language].description) }])),
    durationSec: render.durationSec,
    render: { frames: render.frames, captured: render.captured },
    files: { video: finalVideo, dubVideos, audio, captions, thumbnail },
    narration: Object.fromEntries(languages.map(language => {
      const track = narration.tracks[language];
      return [language, { provider: track.provider, model: track.model, voice: track.voice, draft: track.draft, maxTempo: track.maxTempo, usd: track.usd }];
    })),
    timeline: narration.scenes.map(scene => ({ id: scene.id, startSec: scene.startSec, endSec: scene.endSec })),
    structure: brief.scenes.map(scene => scene.visual.type),
    costUsd: Number(languages.reduce((sum, language) => sum + narration.tracks[language].usd, 0).toFixed(6)),
    containsSyntheticMedia: true
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { produceFromBrief, chaptersFor };
