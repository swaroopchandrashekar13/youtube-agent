const test = require('node:test');
const assert = require('node:assert/strict');
const { requiresSyntheticDisclosure } = require('../../utils/disclosure');

test('AI narration requires disclosure', () => {
  assert.equal(requiresSyntheticDisclosure({ audio: { path: 'a.mp3', provider: 'elevenlabs' } }), true);
  assert.equal(requiresSyntheticDisclosure({ audio: { path: 'a.mp3', provider: 'fake' } }), true);
  assert.equal(requiresSyntheticDisclosure({ audio: { path: 'a.mp3' } }), true, 'unknown provider fails safe');
});

test('human or absent narration does not by itself', () => {
  assert.equal(requiresSyntheticDisclosure({ audio: { path: 'a.wav', provider: 'human' } }), false);
  assert.equal(requiresSyntheticDisclosure({ audio: { intentionalSilence: true, path: 'x' } }), false);
  assert.equal(requiresSyntheticDisclosure({}), false);
});

test('AI video clips and AI images require disclosure', () => {
  assert.equal(requiresSyntheticDisclosure({ finalVideo: { path: 'v.mp4', provider: { actualProvider: 'kling' } } }), true);
  assert.equal(requiresSyntheticDisclosure({ finalVideo: { path: 'v.mp4', provider: { actualProvider: 'slideshow' } } }), false);
  assert.equal(requiresSyntheticDisclosure({ video: { visualAssets: ['x.info', 'y.info'] } }), false);
  assert.equal(requiresSyntheticDisclosure({ video: { visualAssets: ['visual_1.png'] } }), true);
});
