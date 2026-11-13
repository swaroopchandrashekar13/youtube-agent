/**
 * Feature switches for upstream behaviour this fork keeps but does not run by
 * default. Read from the environment on every call (no caching) and fail
 * safe: anything other than an explicit true value means disabled.
 */

const FEATURES = Object.freeze({
  AUTONOMOUS_OPERATOR: 'FEATURE_AUTONOMOUS_OPERATOR',
  GROWTH_EXPERIMENTS: 'FEATURE_GROWTH_EXPERIMENTS',
  REPLY_POSTING: 'FEATURE_REPLY_POSTING',
  SHORTS: 'FEATURE_SHORTS',
  SCHEDULER: 'FEATURE_SCHEDULER',
  ANONYMOUS_TELEMETRY: 'FEATURE_ANONYMOUS_TELEMETRY'
});

const DESCRIPTIONS = {
  FEATURE_AUTONOMOUS_OPERATOR: 'The autonomous channel operator is disabled in this fork; strategy comes from reviewed briefs',
  FEATURE_GROWTH_EXPERIMENTS: 'Live title/thumbnail experiments are disabled in this fork',
  FEATURE_REPLY_POSTING: 'Posting comment replies is disabled in this fork',
  FEATURE_SHORTS: 'Scheduling Shorts is disabled in this fork',
  FEATURE_SCHEDULER: 'The in-process scheduler is disabled in this fork; use job mode',
  FEATURE_ANONYMOUS_TELEMETRY: 'Anonymous telemetry is disabled in this fork'
};

class FeatureDisabledError extends Error {
  /** @param {string} envName */
  constructor(envName) {
    super(`${DESCRIPTIONS[envName] || 'This feature is disabled'} (set ${envName}=true to enable)`);
    this.name = 'FeatureDisabledError';
    this.status = 403;
    this.code = 'FEATURE_DISABLED';
    this.feature = envName;
  }
}

/**
 * @param {string} envName one of FEATURES values
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isFeatureEnabled(envName, env = process.env) {
  return ['true', '1', 'yes'].includes(String(env[envName] || '').trim().toLowerCase());
}

/**
 * @param {string} envName
 * @param {Record<string, string|undefined>} [env]
 */
function assertFeatureEnabled(envName, env = process.env) {
  if (!isFeatureEnabled(envName, env)) throw new FeatureDisabledError(envName);
}

module.exports = { FEATURES, FeatureDisabledError, isFeatureEnabled, assertFeatureEnabled };
