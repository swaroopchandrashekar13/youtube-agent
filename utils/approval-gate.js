/**
 * Fork rule 1: nothing reaches YouTube without a recorded human approval, and
 * every upload starts private. This module is the single place both rules are
 * enforced, so the uploader can call it right before the network request.
 */

const PUBLISH_GRACE_MS = 15 * 60 * 1000;
const SHORT_APPROVED_STATUSES = new Set(['scheduled', 'uploading', 'reconciliation_required', 'published']);

class ApprovalRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalRequiredError';
    this.status = 409;
    this.code = 'HUMAN_APPROVAL_REQUIRED';
  }
}

/**
 * @param {{ review_status?: string, reviewed_at?: string|null } | null | undefined} bundle
 * @returns {boolean}
 */
function isProductionApproved(bundle) {
  return Boolean(bundle && bundle.review_status === 'approved' && bundle.reviewed_at);
}

/**
 * Throws unless the content was approved by a human. Fails closed: if the
 * database cannot answer the question, publishing is refused.
 *
 * @param {object} db Database with getProductionBundle and getShortClip
 * @param {string} contentId Production id or Short clip id
 * @param {object} [scheduleEntry] Schedule entry, used to find a Short's source production
 * @returns {Promise<{kind: 'production'|'short', id: string}>}
 */
async function assertHumanApproved(db, contentId, scheduleEntry = null) {
  if (!db || typeof db.getProductionBundle !== 'function') {
    throw new ApprovalRequiredError('Publishing refused: the approval record cannot be verified');
  }
  const bundle = await db.getProductionBundle(contentId);
  if (bundle) {
    if (!isProductionApproved(bundle)) {
      throw new ApprovalRequiredError('Publishing refused: this video has not been approved by a human');
    }
    return { kind: 'production', id: contentId };
  }

  const clip = typeof db.getShortClip === 'function' ? await db.getShortClip(contentId) : null;
  if (clip) {
    const sourceId = clip.productionId || clip.production_id || scheduleEntry?.metadata?.sourceProductionId;
    const source = sourceId ? await db.getProductionBundle(sourceId) : null;
    if (!SHORT_APPROVED_STATUSES.has(clip.status) || !isProductionApproved(source)) {
      throw new ApprovalRequiredError('Publishing refused: this Short or its source video has not been approved by a human');
    }
    return { kind: 'short', id: contentId };
  }

  throw new ApprovalRequiredError('Publishing refused: no approval record exists for this content');
}

/**
 * Every upload is private. A requested public release becomes a scheduled
 * `publishAt`, which YouTube applies itself; it is never sent as `public`.
 * `unlisted` cannot be scheduled through the API, so it stays private and the
 * operator changes it by hand.
 *
 * @param {object} input
 * @param {string} [input.requestedPrivacy] private | unlisted | public
 * @param {string|Date|null} [input.publishTime] approved release time
 * @param {boolean} [input.publishNow] operator asked to release as soon as possible
 * @param {number} [input.now] epoch ms, for tests
 * @returns {{ privacyStatus: 'private', publishAt?: string, note?: string }}
 */
function resolveUploadPrivacy({ requestedPrivacy = 'private', publishTime = null, publishNow = false, now = Date.now() } = {}) {
  if (requestedPrivacy !== 'public') {
    return {
      privacyStatus: 'private',
      note: requestedPrivacy === 'unlisted' ? 'Uploaded private; set unlisted manually in YouTube Studio' : undefined
    };
  }
  const earliest = now + PUBLISH_GRACE_MS;
  const scheduled = publishTime ? new Date(publishTime).getTime() : NaN;
  const releaseAt = !publishNow && Number.isFinite(scheduled) && scheduled > earliest ? scheduled : earliest;
  return { privacyStatus: 'private', publishAt: new Date(releaseAt).toISOString() };
}

module.exports = {
  ApprovalRequiredError,
  assertHumanApproved,
  isProductionApproved,
  resolveUploadPrivacy,
  PUBLISH_GRACE_MS
};
