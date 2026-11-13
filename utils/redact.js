/**
 * Secret redaction for logs (fork rule 2).
 *
 * Two layers:
 * 1. Exact values of known secret env vars are replaced wherever they appear.
 * 2. Well-known token shapes and sensitive object keys are masked even when
 *    the value did not come from the environment (e.g. OAuth tokens, headers
 *    echoed in an HTTP client error).
 */

const REDACTED = '[REDACTED]';
const MIN_SECRET_LENGTH = 8;

const SENSITIVE_KEY = /(authorization|api[-_]?key|apikey|token|secret|password|passwd|cookie|credential|private[-_]?key)/i;
// Usage counters such as inputTokens/maxOutputTokens are not secrets.
const NON_SECRET_KEY = /((input|output|total|max|prompt|completion|cached|reasoning)[-_]?tokens?|tokens?[-_]?(count|usage|used|limit|budget))$/i;

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(key) && !NON_SECRET_KEY.test(key);
}

const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bya29\.[0-9A-Za-z._-]{20,}/g, // Google OAuth access tokens
  /\b1\/\/[0-9A-Za-z_-]{20,}/g, // Google OAuth refresh tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\br8_[A-Za-z0-9]{20,}\b/g, // Replicate
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g // JWTs
];

const QUERY_SECRET = /([?&](?:key|api_key|apikey|token|access_token|refresh_token|client_secret|signature|sig)=)[^&\s"']+/gi;

/**
 * Secret values currently present in the environment (the listed names plus
 * any variable named *_KEY, *_TOKEN, *_SECRET, *_PASSWORD), longest first so a
 * secret that contains another is replaced whole.
 * @param {readonly string[]} keys
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS)$/;

function secretValues(keys, env = process.env) {
  const values = new Set();
  const names = new Set([...keys, ...Object.keys(env).filter(name => SECRET_NAME.test(name))]);
  for (const key of names) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH) values.add(value.trim());
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string}
 */
function redactText(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let output = text;
  for (const secret of secrets) {
    if (output.includes(secret)) output = output.split(secret).join(REDACTED);
  }
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, REDACTED);
  return output.replace(QUERY_SECRET, `$1${REDACTED}`);
}

/**
 * Deep-copies a value with secrets masked. Handles cycles, Errors and depth.
 * @param {unknown} value
 * @param {string[]} secrets
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function redactValue(value, secrets = [], depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, secrets),
      stack: redactText(value.stack, secrets),
      ...(value.code ? { code: value.code } : {}),
      ...(value.status ? { status: value.status } : {})
    };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactValue(item, secrets, depth + 1, seen));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) && typeof item === 'string') output[key] = REDACTED;
    else if (isSensitiveKey(key) && item && typeof item === 'object' && !Array.isArray(item)) output[key] = redactSensitiveObject(item);
    else output[key] = redactValue(item, secrets, depth + 1, seen);
  }
  return output;
}

/**
 * A sensitive key holding an object (e.g. `tokens: {...}`, `credentials: {...}`)
 * keeps its shape for debugging but loses every scalar.
 * @param {object} value
 * @returns {object}
 */
function redactSensitiveObject(value) {
  const output = {};
  for (const key of Object.keys(value)) output[key] = REDACTED;
  return output;
}

module.exports = { REDACTED, redactText, redactValue, secretValues, isSensitiveKey };
