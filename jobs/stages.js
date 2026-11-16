/**
 * Job-mode stages (fork addition). Each stage runs once against an
 * initialised YouTubeAutomationAgent and returns a result; the runner turns
 * results and errors into exit codes. Stages are idempotent: re-running one
 * resumes or does nothing rather than duplicating work or uploads.
 *
 * Result shape: { outcome: 'ok' | 'noop' | 'needs_human', summary: object }
 */
const { EXIT, jobError } = require('./exit-codes');

const STAGES = Object.freeze(['ingest', 'generate', 'qa', 'notify', 'approvals', 'publish', 'learn']);
// Stages that work before YouTube is connected.
const NO_YOUTUBE_STAGES = Object.freeze(['ingest', 'generate', 'qa', 'notify', 'approvals']);

/**
 * Idempotency key for a generate run: a brief wins, then an explicit topic,
 * otherwise one automatic video per UTC day.
 * @param {{ brief?: string, topic?: string, now?: Date }} input
 */
function generationKey({ brief, topic, now = new Date() }) {
  if (brief) return `brief:${brief}`;
  if (topic) return `topic:${topic.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  return `daily:${now.toISOString().slice(0, 10)}`;
}

async function reviewOutcome(agent, productionId) {
  const bundle = productionId ? await agent.db.getProductionBundle(productionId) : null;
  const reviewStatus = bundle?.review_status || 'unknown';
  return { reviewStatus, outcome: reviewStatus === 'approved' ? 'ok' : 'needs_human' };
}

const stages = {
  async ingest(agent) {
    const { ingestInbox } = require('../pipeline/brief');
    const { TelegramClient } = require('../pipeline/telegram');
    const result = ingestInbox();
    if (result.rejected.length) {
      const telegram = new TelegramClient();
      if (telegram.configured) {
        const lines = result.rejected.map(item => `• ${item.file}: ${item.errors.slice(0, 3).join('; ')}`);
        await telegram.sendMessage(`⚠️ ${result.rejected.length} brief(s) rejected and moved to inbox/rejected:\n${lines.join('\n')}`).catch(() => {});
      }
      await agent.operator?.notify({ type: 'brief_rejected', level: 'warning', title: 'Brief rejected', message: `${result.rejected.length} brief(s) failed validation`, data: result }).catch(() => {});
    }
    return { outcome: result.rejected.length ? 'needs_human' : (result.accepted.length ? 'ok' : 'noop'), summary: result };
  },

  async generateFromBrief(agent, options) {
    const { loadBrief } = require('../pipeline/brief');
    const { produceFromBrief } = require('../pipeline/produce');
    const { runBriefQa } = require('../pipeline/qa');
    const { registerProduction } = require('../pipeline/register');
    const brief = loadBrief(options.brief);
    const productionId = `brief-${brief.briefId}`;
    const existing = await agent.db.getProductionBundle(productionId);
    if (existing && ['approved', 'needs_review'].includes(existing.review_status) && !options.force) {
      return { outcome: existing.review_status === 'approved' ? 'ok' : 'needs_human', summary: { action: 'already_generated', productionId, reviewStatus: existing.review_status } };
    }
    const manifest = await produceFromBrief(brief);
    const qa = await runBriefQa(brief, manifest);
    const registered = await registerProduction(agent.db, brief, manifest, qa);
    return {
      outcome: 'needs_human',
      summary: {
        action: 'created', productionId, title: manifest.title, reviewStatus: registered.status, durationSec: manifest.durationSec,
        costUsd: manifest.costUsd, narration: manifest.narration, video: manifest.files.video,
        qa: { passed: qa.passed, score: qa.score, failed: qa.checks.filter(check => !check.passed).map(check => `${check.id}: ${check.detail}`) }
      }
    };
  },

  async notify(agent, options) {
    const { TelegramClient, notifyPending } = require('../pipeline/telegram');
    const telegram = new TelegramClient();
    if (!telegram.configured) throw jobError('Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)', EXIT.FATAL, 'NOT_CONFIGURED');
    const sent = await notifyPending(agent, telegram, { previewOnly: options['preview-only'] === 'true', content: options.content || null });
    return { outcome: sent.length ? 'needs_human' : 'noop', summary: { sent } };
  },

  async approvals(agent) {
    const { TelegramClient, processDecisions } = require('../pipeline/telegram');
    const { approveProduction } = require('../pipeline/register');
    const telegram = new TelegramClient();
    if (!telegram.configured) throw jobError('Telegram is not configured (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)', EXIT.FATAL, 'NOT_CONFIGURED');
    const youtubeReady = Boolean(agent.agents.publishing);
    const PENDING = 'fork_pending_approval_';
    const applied = [];
    // Decisions taken before YouTube was connected are applied first.
    if (youtubeReady) {
      const settings = await agent.db.getAllSettings();
      for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith(PENDING) || !value) continue;
        const decision = JSON.parse(value.value ?? value);
        await approveProduction(agent, key.slice(PENDING.length), decision);
        await agent.db.setSetting(key, '', 'applied');
        applied.push(key.slice(PENDING.length));
      }
    }
    const decisions = await processDecisions(agent, telegram, {
      approve: async (id, decision) => {
        if (youtubeReady) return approveProduction(agent, id, decision);
        // The human decision is recorded; scheduling waits for the YouTube connection.
        await agent.db.setSetting(`${PENDING}${id}`, JSON.stringify(decision), 'Human approval awaiting YouTube connection');
        return { deferred: true };
      }
    });
    return { outcome: decisions.length || applied.length ? 'ok' : 'noop', summary: { decisions, appliedDeferred: applied } };
  },

  async generate(agent, options) {
    if (options.brief) return stages.generateFromBrief(agent, options);
    if (!agent.agents.strategy) throw jobError('Topic-based generation needs completed setup; use --brief=<id>', EXIT.FATAL, 'SETUP_REQUIRED');
    const jobKey = generationKey(options);
    let job = await agent.db.findGenerationJobByKey(jobKey);
    let action;

    if (job?.status === 'completed') {
      const review = await reviewOutcome(agent, job.production_id);
      return {
        outcome: review.outcome,
        summary: { action: 'already_generated', jobKey, jobId: job.id, productionId: job.production_id, reviewStatus: review.reviewStatus }
      };
    }
    if (job && ['failed', 'interrupted'].includes(job.status)) {
      action = 'resumed';
      await agent.resumeGenerationJob(job.id);
    } else if (job && ['queued', 'running'].includes(job.status)) {
      // We hold the lease, so nothing else is running it; initialise() normally marks these interrupted.
      throw jobError(`Job ${job.id} is ${job.status} without a runner; retry to resume it`, EXIT.TRANSIENT, 'JOB_STALE');
    } else {
      action = job ? 'restarted' : 'created';
      job = await agent.startGenerationJob({ topic: options.topic || null, length: options.length || 'medium', source: 'job', jobKey });
    }

    await agent.waitForGenerationJob(job.id);
    const finished = await agent.db.getGenerationJob(job.id);
    if (finished.status !== 'completed') {
      const error = new Error(finished.error || `Generation ${finished.status}`);
      // Stage failures are retryable when the recovery service classified them as transient.
      error.code = /timeout|rate|429|5\d\d|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(finished.error || '') ? 'ETIMEDOUT' : 'GENERATION_FAILED';
      throw error;
    }
    const review = await reviewOutcome(agent, finished.production_id);
    return {
      outcome: review.outcome,
      summary: { action, jobKey, jobId: finished.id, productionId: finished.production_id, title: finished.title, reviewStatus: review.reviewStatus }
    };
  },

  async qa(agent, options) {
    const rows = options.content
      ? [{ id: options.content }]
      : await agent.db.getAllRows(
        `SELECT p.id FROM productions p JOIN content_reviews cr ON cr.production_id = p.id
         WHERE cr.status IN ('needs_review', 'needs_attention') ORDER BY p.created_at`
      );
    const profile = await agent.db.getChannelProfile() || {};
    const results = [];
    for (const { id } of rows) {
      const bundle = await agent.db.getProductionBundle(id);
      if (!bundle) throw jobError(`Content not found: ${id}`, EXIT.FATAL, 'NOT_FOUND');
      if (bundle.review_status === 'approved') {
        results.push({ id, reviewStatus: 'approved', skipped: true });
        continue;
      }
      const quality = await agent.operator.runQualityChecks(bundle, profile);
      // QA can move content between needs_review and needs_attention but never approves it.
      const status = quality.passed ? 'needs_review' : 'needs_attention';
      await agent.db.saveContentReview(id, {
        status,
        editorData: bundle.editorData || {},
        qualityChecks: quality.checks,
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      await agent.db.updateProductionStatus(id, status);
      results.push({ id, reviewStatus: status, score: quality.score, blocking: quality.blockingFailures });
    }
    const waiting = results.filter(item => !item.skipped);
    return { outcome: waiting.length ? 'needs_human' : 'noop', summary: { checked: results.length, results } };
  },

  async publish(agent, options) {
    const publishing = agent.agents.publishing;
    if (!publishing) throw jobError('Publishing is not configured', EXIT.FATAL, 'NOT_CONFIGURED');
    await publishing.loadPublishQueue();
    const targets = options.content
      ? [options.content]
      : [...new Set(publishing.publishQueue.filter(entry => entry.status === 'scheduled').map(entry => entry.productionId))];
    if (!targets.length) return { outcome: 'noop', summary: { published: [], message: 'Nothing approved is waiting to upload' } };

    const published = [];
    const blocked = [];
    for (const id of targets) {
      try {
        // Uploads private; an approved public release is sent as publishAt (approval-gate.js).
        const entry = await publishing.publishContent(id);
        await agent.db.updateProductionStatus(id, entry.status);
        published.push({ id, youtubeId: entry.youtubeId, status: entry.status, publishAt: entry.publishTime });
      } catch (error) {
        if (['HUMAN_APPROVAL_REQUIRED', 'READINESS_BLOCKED', 'PROVENANCE_BLOCKED', 'NARRATION_REQUIRED', 'UPLOAD_OUTCOME_UNKNOWN'].includes(error.code)) {
          blocked.push({ id, code: error.code, reason: error.message });
          continue;
        }
        throw error;
      }
    }
    return { outcome: blocked.length ? 'needs_human' : 'ok', summary: { published, blocked } };
  },

  async learn(agent, options = {}) {
    const analytics = agent.agents.analytics;
    if (!analytics) throw jobError('Analytics is not configured', EXIT.FATAL, 'NOT_CONFIGURED');
    // Phase 8 writes feedback/*.json; for now this records 24h/7d evidence in the database.
    const { DailyAutomation } = require('../schedules/daily-automation');
    const helper = new DailyAutomation(agent.agents, agent.db, {});
    const videos = await helper.getRecentlyPublishedVideos(30);
    const captured = [];
    const failed = [];
    for (const video of videos) {
      try {
        for (const measurementWindow of await analytics.getDueMeasurementWindows(video)) {
          await analytics.analyzeVideoPerformance(video.youtube_id, { measurementWindow });
          captured.push({ youtubeId: video.youtube_id, measurementWindow });
          if (options.delayMs !== 0) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 2000));
        }
      } catch (error) {
        failed.push({ youtubeId: video.youtube_id, error: error.message, code: error.code, status: error.status || error.response?.status });
      }
    }
    if (failed.length && !captured.length) {
      const error = new Error(`Analytics failed for all ${failed.length} video(s): ${failed[0].error}`);
      error.code = failed[0].code;
      error.status = failed[0].status;
      throw error;
    }
    return { outcome: videos.length ? 'ok' : 'noop', summary: { videos: videos.length, captured, failed } };
  }
};

module.exports = { STAGES, NO_YOUTUBE_STAGES, stages, generationKey };
