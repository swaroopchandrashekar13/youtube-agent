/**
 * Job-mode exit codes (fork addition). Schedulers and the approval Lambda
 * decide what to do next from these alone.
 *
 *   0  OK           stage finished, or there was nothing to do
 *   10 NEEDS_HUMAN  work is waiting for a person (review, approval, a disabled feature, a quality failure)
 *   20 TRANSIENT    try again later (network, rate limit, another run holds the lease, timeout, SIGTERM)
 *   30 FATAL        configuration or code problem; retrying will not help
 */

const EXIT = Object.freeze({ OK: 0, NEEDS_HUMAN: 10, TRANSIENT: 20, FATAL: 30 });

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT',
  'LEASE_HELD', 'JOB_TIMEOUT', 'JOB_TERMINATED', 'SQLITE_BUSY', 'UPLOAD_OUTCOME_UNKNOWN'
]);
const HUMAN_CODES = new Set([
  'HUMAN_APPROVAL_REQUIRED', 'FEATURE_DISABLED', 'READINESS_BLOCKED', 'PROVENANCE_BLOCKED',
  'NARRATION_REQUIRED', 'REPLY_SCOPE_REQUIRED', 'NEEDS_HUMAN'
]);
const FATAL_NAMES = new Set(['ConfigError', 'TypeError', 'ReferenceError', 'SyntaxError']);

/**
 * Maps an error to an exit code. Unknown errors are fatal, so a broken
 * pipeline does not retry forever and spend money.
 * @param {any} error
 * @returns {number}
 */
function exitCodeFor(error) {
  if (!error) return EXIT.OK;
  if (Number.isInteger(error.exitCode) && Object.values(EXIT).includes(error.exitCode)) return error.exitCode;
  if (FATAL_NAMES.has(error.name)) return EXIT.FATAL;
  const code = String(error.code || '').toUpperCase();
  if (HUMAN_CODES.has(code)) return EXIT.NEEDS_HUMAN;
  if (TRANSIENT_CODES.has(code)) return EXIT.TRANSIENT;
  const status = Number(error.status || error.statusCode || error.response?.status || 0);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return EXIT.TRANSIENT;
  return EXIT.FATAL;
}

/**
 * @param {string} message
 * @param {number} exitCode
 * @param {string} [code]
 */
function jobError(message, exitCode, code) {
  const error = new Error(message);
  error.exitCode = exitCode;
  if (code) error.code = code;
  return error;
}

module.exports = { EXIT, exitCodeFor, jobError };
