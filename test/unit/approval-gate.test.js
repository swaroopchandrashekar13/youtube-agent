const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertHumanApproved, resolveUploadPrivacy, isProductionApproved, PUBLISH_GRACE_MS
} = require('../../utils/approval-gate');

const approvedBundle = { review_status: 'approved', reviewed_at: '2026-11-13T00:00:00Z' };

function db({ bundles = {}, clips = {} } = {}) {
  return {
    getProductionBundle: async id => bundles[id] || null,
    getShortClip: async id => clips[id] || null
  };
}

test('approved production passes', async () => {
  const result = await assertHumanApproved(db({ bundles: { p1: approvedBundle } }), 'p1');
  assert.deepEqual(result, { kind: 'production', id: 'p1' });
});

test('unreviewed, rejected or timestamp-less production is refused', async () => {
  for (const bundle of [
    { review_status: 'needs_review', reviewed_at: null },
    { review_status: 'rejected', reviewed_at: '2026-11-13T00:00:00Z' },
    { review_status: 'approved', reviewed_at: null }
  ]) {
    await assert.rejects(assertHumanApproved(db({ bundles: { p1: bundle } }), 'p1'), { code: 'HUMAN_APPROVAL_REQUIRED' });
  }
});

test('fails closed when the database cannot verify', async () => {
  await assert.rejects(assertHumanApproved({}, 'p1'), { code: 'HUMAN_APPROVAL_REQUIRED' });
  await assert.rejects(assertHumanApproved(null, 'p1'), { code: 'HUMAN_APPROVAL_REQUIRED' });
  await assert.rejects(assertHumanApproved(db(), 'unknown'), { code: 'HUMAN_APPROVAL_REQUIRED' });
});

test('short needs its own approval and an approved source', async () => {
  const ok = db({ bundles: { src: approvedBundle }, clips: { c1: { status: 'scheduled', productionId: 'src' } } });
  assert.equal((await assertHumanApproved(ok, 'c1')).kind, 'short');

  const draft = db({ bundles: { src: approvedBundle }, clips: { c1: { status: 'rendered', productionId: 'src' } } });
  await assert.rejects(assertHumanApproved(draft, 'c1'), { code: 'HUMAN_APPROVAL_REQUIRED' });

  const unapprovedSource = db({ bundles: { src: { review_status: 'needs_review' } }, clips: { c1: { status: 'scheduled', productionId: 'src' } } });
  await assert.rejects(assertHumanApproved(unapprovedSource, 'c1'), { code: 'HUMAN_APPROVAL_REQUIRED' });
});

test('isProductionApproved', () => {
  assert.equal(isProductionApproved(approvedBundle), true);
  assert.equal(isProductionApproved(null), false);
});

test('uploads are always private', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  for (const requestedPrivacy of ['private', 'unlisted', 'public', 'bogus', undefined]) {
    assert.equal(resolveUploadPrivacy({ requestedPrivacy, now }).privacyStatus, 'private');
  }
  assert.equal(resolveUploadPrivacy({ requestedPrivacy: 'private', now }).publishAt, undefined);
  assert.match(resolveUploadPrivacy({ requestedPrivacy: 'unlisted', now }).note, /unlisted/);
});

test('public release becomes a scheduled publishAt', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  const future = '2026-11-14T10:00:00.000Z';
  assert.equal(resolveUploadPrivacy({ requestedPrivacy: 'public', publishTime: future, now }).publishAt, future);

  const graceAt = new Date(now + PUBLISH_GRACE_MS).toISOString();
  assert.equal(resolveUploadPrivacy({ requestedPrivacy: 'public', publishTime: '2026-11-12T00:00:00Z', now }).publishAt, graceAt);
  assert.equal(resolveUploadPrivacy({ requestedPrivacy: 'public', publishTime: future, publishNow: true, now }).publishAt, graceAt);
  assert.equal(resolveUploadPrivacy({ requestedPrivacy: 'public', publishTime: 'garbage', now }).publishAt, graceAt);
});
