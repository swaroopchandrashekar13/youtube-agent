/**
 * Telegram bot client and approval flow (fork addition).
 *
 * - The bot token only ever appears in the request URL, which is never logged.
 * - Only the allow-listed chat (TELEGRAM_CHAT_ID) can approve or reject.
 * - Callback data is an opaque token mapped server-side, so a forged button
 *   cannot name arbitrary content.
 * - In fake mode nothing is sent; calls are recorded to a file for tests.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runFFmpeg } = require('../utils/ffmpeg');

const API = 'https://api.telegram.org';
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024; // bot uploads are limited to 50 MB

class TelegramClient {
  constructor({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, fake = String(process.env.PROVIDERS_MODE).toLowerCase() === 'fake', recordDir } = {}) {
    this.token = token;
    this.chatId = chatId ? String(chatId) : null;
    this.fake = fake;
    this.recordFile = path.join(recordDir || process.env.FAKE_TELEGRAM_DIR || path.join(__dirname, '..', 'data', 'fake-telegram'), 'calls.jsonl');
    this.fakeUpdates = [];
  }

  get configured() {
    return this.fake || Boolean(this.token && this.chatId);
  }

  async call(method, params = {}, files = {}) {
    if (this.fake) {
      fs.mkdirSync(path.dirname(this.recordFile), { recursive: true });
      const entry = { method, params, files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, path.basename(file)])) };
      fs.appendFileSync(this.recordFile, `${JSON.stringify(entry)}\n`);
      if (method === 'getUpdates') {
        // Tests drop simulated button presses into updates.json next to the call log.
        const file = path.join(path.dirname(this.recordFile), 'updates.json');
        const queued = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
        if (queued.length) fs.writeFileSync(file, '[]');
        return [...this.fakeUpdates.splice(0), ...queued];
      }
      return { message_id: Math.floor(Math.random() * 1e6), chat: { id: this.chatId } };
    }
    if (!this.token) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is not set'), { code: 'NOT_CONFIGURED' });
    let body;
    const headers = {};
    if (Object.keys(files).length) {
      body = new FormData();
      for (const [key, value] of Object.entries(params)) body.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      for (const [key, file] of Object.entries(files)) body.append(key, new Blob([fs.readFileSync(file)]), path.basename(file));
    } else {
      body = JSON.stringify(params);
      headers['content-type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(`${API}/bot${this.token}/${method}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(Object.keys(files).length ? 300000 : 40000) });
    } catch (error) {
      // Never surface the URL: it contains the token.
      throw Object.assign(new Error(`Telegram ${method} failed: ${error.name === 'TimeoutError' ? 'timeout' : 'network error'}`), { code: 'ETIMEDOUT' });
    }
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw Object.assign(new Error(`Telegram ${method} failed: ${data.description || response.status}`), { status: response.status });
    return data.result;
  }

  sendMessage(text, extra = {}) {
    return this.call('sendMessage', { chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });
  }

  sendVideo(file, caption, extra = {}) {
    return this.call('sendVideo', { chat_id: this.chatId, caption: caption.slice(0, 1000), supports_streaming: 'true', ...extra }, { video: file });
  }

  sendPhoto(file, caption = '') {
    return this.call('sendPhoto', { chat_id: this.chatId, caption: caption.slice(0, 1000) }, { photo: file });
  }
}

/** 480p preview that fits under the bot upload limit. */
async function makePreview(videoPath, outPath) {
  for (const [height, crf] of [[480, 28], [360, 32]]) {
    await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf', `scale=-2:${height}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath]);
    if (fs.statSync(outPath).size <= MAX_UPLOAD_BYTES) return outPath;
  }
  throw new Error('Preview is still larger than the Telegram upload limit');
}

function nextEveningIst(now = new Date()) {
  // 18:00 IST = 12:30 UTC; the next one at least 2 hours away.
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 30));
  while (target.getTime() - now.getTime() < 2 * 3600000) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

const REJECT_REASONS = { facts: 'Facts or sources are wrong', voice: 'Voice or pronunciation', visuals: 'Visuals or pacing', topic: 'Topic is not right', other: 'Other' };

function approvalKeyboard(token) {
  return {
    inline_keyboard: [
      [{ text: '✅ Approve · publish 6 PM IST', callback_data: `ap6:${token}` }],
      [{ text: '✅ Approve · publish in 1 hour', callback_data: `ap1:${token}` }, { text: '🔒 Approve · keep private', callback_data: `app:${token}` }],
      [{ text: '❌ Reject', callback_data: `rej:${token}` }]
    ]
  };
}

function rejectKeyboard(token) {
  return { inline_keyboard: Object.entries(REJECT_REASONS).map(([key, label]) => [{ text: label, callback_data: `rr:${key}:${token}` }]) };
}

function reviewCaption(bundle, qa, { test = false } = {}) {
  const brief = bundle.assets?.brief || {};
  const failed = (qa || []).filter(check => !check.passed);
  const lines = [
    `${test ? '🧪 TEST · ' : ''}🎬 ${bundle.seo?.title || bundle.script?.title}`,
    `Channel: ${brief.channelId || '-'} · ${bundle.estimated_duration || ''} · cost $${Number(brief.costUsd || 0).toFixed(3)}`,
    failed.length ? `⚠️ Checks failed: ${failed.map(check => check.id).join(', ')}` : '✅ All quality checks passed',
    '',
    'Approving confirms you checked the facts against the sources below and that the media is ours to use.'
  ];
  return lines.join('\n');
}

function sourcesMessage(bundle) {
  const sources = bundle.provenance?.sources || [];
  return ['Sources to check:', ...sources.map((source, index) => `${index + 1}. ${source.title}\n${source.url}`)].join('\n\n');
}

/**
 * Sends every unsent `needs_review` production to Telegram with approval buttons.
 */
async function notifyPending(agent, telegram, { previewOnly = false, content = null } = {}) {
  const rows = content ? [{ production_id: content }] : await agent.db.getAllRows(
    "SELECT production_id FROM content_reviews WHERE status IN ('needs_review', 'needs_attention') ORDER BY updated_at");
  const sent = [];
  for (const { production_id: id } of rows) {
    const bundle = await agent.db.getProductionBundle(id);
    if (!bundle || !bundle.assets?.brief) continue;
    if (bundle.editorData?.telegram?.messageId && !previewOnly) continue;
    const video = bundle.assets.finalVideo?.path;
    if (!video || !fs.existsSync(video)) continue;
    const reviewable = bundle.review_status === 'needs_review';
    const token = crypto.randomBytes(8).toString('hex');
    const preview = path.join(path.dirname(video), 'preview.mp4');
    await makePreview(video, preview);
    const withButtons = reviewable && !previewOnly;
    const message = await telegram.sendVideo(preview, reviewCaption(bundle, bundle.qualityChecks, { test: previewOnly }),
      withButtons ? { reply_markup: approvalKeyboard(token) } : {});
    if (fs.existsSync(bundle.assets.thumbnail?.path || '')) await telegram.sendPhoto(bundle.assets.thumbnail.path, 'Thumbnail');
    for (const [language, dub] of Object.entries(bundle.assets.dubs || {})) {
      if (!fs.existsSync(dub.video || '')) continue;
      const dubPreview = path.join(path.dirname(video), `preview.${language}.mp4`);
      await makePreview(dub.video, dubPreview);
      await telegram.sendVideo(dubPreview, `Audio track: ${language}`);
    }
    await telegram.sendMessage(sourcesMessage(bundle));
    if (!reviewable) await telegram.sendMessage(`This video cannot be approved yet: ${bundle.review_notes || 'quality checks failed'}`);
    if (withButtons) {
      await agent.db.setSetting(`fork_tg_token_${token}`, id, 'Telegram approval token');
      await agent.db.saveContentReview(id, {
        status: bundle.review_status, editorData: { ...bundle.editorData, telegram: { messageId: message.message_id, token, sentAt: new Date().toISOString() } },
        qualityChecks: bundle.qualityChecks || [], reviewNotes: bundle.review_notes || null, reviewedAt: null
      });
    }
    sent.push({ id, reviewable, buttons: withButtons });
  }
  return sent;
}

/**
 * Reads button presses and applies decisions. Only the allow-listed chat counts.
 */
async function processDecisions(agent, telegram, { approve }) {
  const offsetKey = 'fork_tg_update_offset';
  const offset = Number(await agent.db.getSetting(offsetKey)) || 0;
  const updates = await telegram.call('getUpdates', { offset, timeout: 0, allowed_updates: ['callback_query'] });
  const results = [];
  let next = offset;
  for (const update of updates || []) {
    next = Math.max(next, update.update_id + 1);
    const query = update.callback_query;
    if (!query) continue;
    const fromChat = String(query.message?.chat?.id ?? '');
    if (!telegram.chatId || fromChat !== telegram.chatId) {
      results.push({ ignored: 'chat not allow-listed' });
      continue;
    }
    const match = String(query.data || '').match(/^(ap6|ap1|app|rej|rr:[a-z]+):([0-9a-f]{16})$/);
    const id = match ? await agent.db.getSetting(`fork_tg_token_${match[2]}`) : null;
    const answer = text => telegram.call('answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 190) }).catch(() => {});
    if (!match || !id) {
      await answer('This button has expired.');
      continue;
    }
    const bundle = await agent.db.getProductionBundle(id);
    const action = match[1];
    const reviewer = `telegram:${query.from?.id || 'unknown'}`;
    try {
      if (action === 'rej') {
        await telegram.sendMessage(`Why reject "${bundle.seo?.title}"?`, { reply_markup: rejectKeyboard(match[2]) });
        await answer('Choose a reason');
      } else if (action.startsWith('rr:')) {
        const reason = REJECT_REASONS[action.slice(3)] || 'Other';
        await agent.db.saveContentReview(id, { status: 'rejected', editorData: bundle.editorData, qualityChecks: bundle.qualityChecks || [], reviewNotes: `Rejected by ${reviewer}: ${reason}`, reviewedAt: new Date().toISOString() });
        await agent.db.updateProductionStatus(id, 'rejected');
        await answer('Rejected');
        await telegram.sendMessage(`❌ Rejected: ${bundle.seo?.title}\nReason: ${reason}`);
        results.push({ id, decision: 'rejected', reason });
      } else if (bundle.review_status !== 'needs_review') {
        await answer(`Already ${bundle.review_status}`);
      } else {
        const now = new Date();
        const publishTime = action === 'ap1' ? new Date(now.getTime() + 3600000) : action === 'ap6' ? nextEveningIst(now) : new Date(now.getTime() + 3600000);
        const privacyStatus = action === 'app' ? 'private' : 'public';
        const outcome = await approve(id, { publishTime: publishTime.toISOString(), privacyStatus, reviewer });
        await answer('Approved');
        await telegram.sendMessage(outcome.deferred
          ? `✅ Approval recorded for "${bundle.seo?.title}". YouTube is not connected yet, so it will be scheduled once the channel is linked.`
          : `✅ Approved: ${bundle.seo?.title}\n${privacyStatus === 'public' ? `Goes public at ${publishTime.toISOString()}` : 'Will be uploaded as private'}\n\nBefore it goes public, check in YouTube Studio that "Altered or synthetic content" shows Yes.`);
        results.push({ id, decision: 'approved', privacyStatus, publishTime: publishTime.toISOString(), deferred: Boolean(outcome.deferred) });
      }
    } catch (error) {
      await answer('Could not apply that. See the message below.');
      await telegram.sendMessage(`⚠️ Could not apply your decision for "${bundle?.seo?.title || id}": ${error.message}`);
      results.push({ id, error: error.message });
    }
  }
  if (next !== offset) await agent.db.setSetting(offsetKey, String(next), 'Telegram getUpdates offset');
  return results;
}

module.exports = { TelegramClient, makePreview, notifyPending, processDecisions, nextEveningIst, approvalKeyboard, REJECT_REASONS };
