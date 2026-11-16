/**
 * Bridges brief-driven productions into the upstream database so the existing
 * review, approval-gate, scheduling and upload code handles them unchanged.
 */
const { ProvenanceService } = require('../utils/provenance-service');

function claimsFor(brief) {
  return brief.scenes.filter(scene => scene.factual).map(scene => ({
    id: `claim_${scene.id}`,
    text: scene.narration.slice(0, 900),
    sourceIds: scene.sourceRefs,
    riskLevel: 'standard'
  }));
}

function sourcesFor(brief, status) {
  return brief.sources.map(source => ({ id: source.id, url: source.url, title: source.title, publisher: source.publisher || '', type: 'article', status, notes: source.claimSupported }));
}

/**
 * @param {object} db upstream Database
 * @param {object} brief
 * @param {object} manifest
 * @param {{ passed: boolean, checks: object[], blockingFailures: string[] }} qa
 */
async function registerProduction(db, brief, manifest, qa) {
  const id = manifest.productionId;
  const existing = await db.getProductionBundle(id);
  if (existing?.review_status === 'approved') {
    throw Object.assign(new Error(`${id} is already approved; it will not be re-rendered`), { code: 'ALREADY_APPROVED', exitCode: 0 });
  }
  const main = manifest.narration[brief.language];
  const status = qa.passed ? 'needs_review' : 'needs_attention';
  const production = {
    id,
    status,
    assets: {
      finalVideo: { path: manifest.files.video, simulated: false, format: 'mp4', resolution: '1920x1080', provider: { requestedProvider: 'templates', actualProvider: 'slideshow', model: 'yt-agent-templates', mode: 'brief' } },
      thumbnail: { path: manifest.files.thumbnail },
      audio: { path: manifest.files.audio[brief.language], provider: main.provider, model: main.model, simulated: false, draft: main.draft, status: 'ready' },
      captions: { path: manifest.files.captions[brief.language].srt, format: 'srt', language: brief.language },
      dubs: Object.fromEntries(Object.keys(manifest.localizations).map(language => [language, { video: manifest.files.dubVideos[language], audio: manifest.files.audio[language], captions: manifest.files.captions[language].srt }])),
      brief: { briefId: brief.briefId, channelId: brief.channelId, costUsd: manifest.costUsd, durationSec: manifest.durationSec }
    },
    timeline: manifest.timeline,
    scheduledPublishTime: brief.publishAfter || null,
    priority: 50,
    estimatedDuration: `${Math.floor(manifest.durationSec / 60)}:${String(Math.round(manifest.durationSec % 60)).padStart(2, '0')}`,
    strategy: { topic: manifest.title, source: 'brief', briefId: brief.briefId, channelId: brief.channelId, researchSources: brief.sources.map(source => source.url) },
    script: { title: manifest.title, fullScript: brief.scenes.map(scene => scene.narration).join('\n\n'), claims: claimsFor(brief) },
    thumbnail: { path: manifest.files.thumbnail },
    seo: {
      title: manifest.title, description: manifest.description, tags: manifest.tags,
      defaultLanguage: brief.language, defaultAudioLanguage: brief.language,
      localizations: manifest.localizations
    }
  };
  await db.saveProductionData(production);
  await db.saveProductionSnapshot(production);
  await db.saveContentReview(id, {
    status,
    editorData: { ...(existing?.editorData || {}), titleCandidates: manifest.titleCandidates, briefId: brief.briefId, channelId: brief.channelId, telegram: null },
    qualityChecks: qa.checks,
    reviewNotes: qa.passed ? null : `Blocking checks failed: ${qa.blockingFailures.join(', ')}`,
    reviewedAt: null
  });
  // Claims start unverified: only the human approver can mark them supported.
  await new ProvenanceService(db).review(id, { sources: sourcesFor(brief, 'pending'), claims: claimsFor(brief).map(claim => ({ ...claim, status: 'pending' })), containsSyntheticMedia: true });
  return { productionId: id, status };
}

/**
 * Records the human decision. Called only from a verified human action
 * (Telegram button from the allow-listed chat, or the local dashboard).
 */
async function approveProduction(agent, productionId, { publishTime, privacyStatus, reviewer }) {
  const bundle = await agent.db.getProductionBundle(productionId);
  if (!bundle) throw Object.assign(new Error(`Content not found: ${productionId}`), { code: 'NOT_FOUND' });
  const provenance = bundle.provenance || {};
  await new ProvenanceService(agent.db).review(productionId, {
    sources: (provenance.sources || []).map(source => ({ ...source, status: 'verified' })),
    claims: (provenance.claims || []).map(claim => ({ ...claim, status: 'supported', notes: `Confirmed by ${reviewer}` })),
    containsSyntheticMedia: true
  });
  return agent.approveContent(productionId, { factChecked: true, rightsConfirmed: true, publishTime, privacyStatus, reviewNotes: `Approved by ${reviewer}` });
}

module.exports = { registerProduction, approveProduction, claimsFor };
