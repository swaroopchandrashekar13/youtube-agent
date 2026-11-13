/**
 * Validated runtime configuration (fork addition).
 *
 * Every environment variable this fork relies on is declared here with a type
 * and a safe default. Validation errors name the variable but never echo its
 * value, so a mistyped secret cannot leak into logs.
 */
const { z } = require('zod');
const { isLoopbackHost } = require('./http-security');

/** Environment variables whose values are secrets. Used by the redacting logger. */
const SECRET_ENV_KEYS = Object.freeze([
  'API_KEY',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
  'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'MIMO_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY',
  'DEEPSEEK_API_KEY', 'MINIMAX_API_KEY', 'DASHSCOPE_API_KEY',
  'ELEVENLABS_API_KEY', 'AZURE_SPEECH_KEY', 'REPLICATE_API_TOKEN', 'REPLICATE_API_KEY',
  'KLING_ACCESS_KEY', 'KLING_SECRET_KEY',
  'PEXELS_API_KEY', 'PIXABAY_API_KEY', 'SARVAM_API_KEY',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
  'GITHUB_SYNC_TOKEN', 'GOOGLE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'
]);

/**
 * Boolean from an env string. Unset or empty uses the default; anything other
 * than true/false/1/0/yes/no is a validation error rather than a silent guess.
 * @param {boolean} defaultValue
 */
const flag = defaultValue => z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === '') return defaultValue;
    if (['true', '1', 'yes'].includes(value)) return true;
    if (['false', '0', 'no'].includes(value)) return false;
    ctx.addIssue({ code: 'custom', message: 'must be true or false' });
    return z.NEVER;
  });

/** Optional integer within bounds; empty string counts as unset. */
const int = (min, max, defaultValue) => z.preprocess(
  value => (value === '' || value === undefined ? defaultValue : value),
  defaultValue === undefined
    ? z.coerce.number().int().min(min).max(max).optional()
    : z.coerce.number().int().min(min).max(max)
);

const optionalText = z.string().trim().min(1).optional().or(z.literal('').transform(() => undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(1, 65535, 3456),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  ALLOWED_HOSTS: z.string().default('').transform(value => value.split(',').map(item => item.trim()).filter(Boolean)),
  API_KEY: optionalText.refine(value => value === undefined || value.length >= 24, 'must be at least 24 characters'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // Fork rule 1: this is the privacy requested *after* approval. Uploads are always private first.
  DEFAULT_PRIVACY_STATUS: z.enum(['private', 'unlisted', 'public']).default('private'),

  PROVIDERS_MODE: z.enum(['live', 'fake']).default('live'),
  CHANNEL_LANGUAGE: z.enum(['en', 'kn']).default('en'),

  // Upstream features that act on their own; off unless explicitly enabled.
  FEATURE_AUTONOMOUS_OPERATOR: flag(false),
  FEATURE_GROWTH_EXPERIMENTS: flag(false),
  FEATURE_REPLY_POSTING: flag(false),
  FEATURE_SHORTS: flag(false),
  FEATURE_SCHEDULER: flag(false),
  FEATURE_ANONYMOUS_TELEMETRY: flag(false),

  GENERATION_STAGE_MAX_ATTEMPTS: int(1, 10, undefined),
  GENERATION_RETRY_BASE_MS: int(0, 600000, undefined),
  MAX_CONCURRENT_JOBS: int(1, 16, undefined),
  ENGAGEMENT_DAILY_REPLY_CAP: int(0, 1000, undefined),
  FFMPEG_PATH: optionalText,
  FFPROBE_PATH: optionalText,
  NOTIFICATION_WEBHOOK_URL: optionalText.refine(
    value => value === undefined || /^https:\/\//.test(value), 'must be an https URL')
}).passthrough().superRefine((config, ctx) => {
  if (!isLoopbackHost(config.HOST) && !config.API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_KEY'],
      message: `is required when HOST (${config.HOST}) is not a loopback address`
    });
  }
  if (config.NODE_ENV === 'production' && config.PROVIDERS_MODE === 'fake') {
    ctx.addIssue({ code: 'custom', path: ['PROVIDERS_MODE'], message: 'fake providers are not allowed when NODE_ENV=production' });
  }
});

class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * @typedef {z.infer<typeof schema>} AppConfig
 */

/**
 * Validates the environment. Never includes values in error messages.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<AppConfig>}
 */
function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'} ${issue.message}`);
    throw new ConfigError(problems);
  }
  return Object.freeze(result.data);
}

let cached = null;

/**
 * Cached config for the current process. Call `resetConfig()` in tests.
 * @returns {Readonly<AppConfig>}
 */
function getConfig() {
  if (!cached) cached = loadConfig(process.env);
  return cached;
}

function resetConfig() {
  cached = null;
}

module.exports = { loadConfig, getConfig, resetConfig, ConfigError, SECRET_ENV_KEYS, schema };
