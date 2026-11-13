/**
 * Dashboard/API hardening for the local operator console.
 *
 * - Host allow-list: blocks DNS-rebinding pages from talking to 127.0.0.1.
 * - Origin check on state-changing requests: blocks cross-site form/fetch CSRF.
 *   Browsers always send Origin on cross-origin POST/PUT/PATCH/DELETE; requests
 *   without Origin come from non-browser local clients (curl, scripts).
 * - When API_KEY is set, every /api route (reads included) needs the key, from
 *   the x-api-key header or the SameSite=Strict `yaa_api_key` cookie that the
 *   dashboard sets so <img>/<video> previews keep working.
 * - Constant-time key comparison.
 */
const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];
const LEGACY_DATA_ROUTES = ['/analytics', '/schedule', '/generate', '/publish/'];

/**
 * Routes that return or change channel data. Static dashboard files, `/` and `/health` stay open.
 * @param {string} pathname
 * @returns {boolean}
 */
function isProtectedPath(pathname) {
  const value = String(pathname || '');
  return value.startsWith('/api/') || LEGACY_DATA_ROUTES.some(route =>
    route.endsWith('/') ? value.startsWith(route) : value === route || value.startsWith(`${route}/`));
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase();
  return LOOPBACK_NAMES.includes(value) || /^127\./.test(value);
}

/**
 * @param {string|undefined} provided
 * @param {string|undefined} expected
 * @returns {boolean}
 */
function apiKeyMatches(provided, expected) {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
function extractApiKey(req) {
  const header = req.get('x-api-key');
  if (header) return header;
  const cookies = String(req.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const index = cookie.indexOf('=');
    if (index > 0 && cookie.slice(0, index).trim() === 'yaa_api_key') {
      try {
        return decodeURIComponent(cookie.slice(index + 1).trim());
      } catch (_error) {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Hostname without port, lower-cased. Handles bracketed IPv6.
 * @param {string} value
 * @returns {string}
 */
function hostnameOf(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.startsWith('[')) return text.slice(0, text.indexOf(']') + 1);
  return text.split(':')[0];
}

/**
 * @param {{ bindHost?: string, extraHosts?: string[] }} options
 * @returns {Set<string>}
 */
function allowedHostnames({ bindHost = '127.0.0.1', extraHosts = [] } = {}) {
  const names = new Set(LOOPBACK_NAMES);
  if (bindHost && !['0.0.0.0', '::'].includes(bindHost)) names.add(hostnameOf(bindHost));
  for (const host of extraHosts) if (host) names.add(hostnameOf(host));
  return names;
}

/**
 * @param {{ bindHost?: string, extraHosts?: string[], apiKey?: string }} options
 * @returns {import('express').RequestHandler}
 */
function securityMiddleware({ bindHost, extraHosts = [], apiKey } = {}) {
  const allowed = allowedHostnames({ bindHost, extraHosts });
  return (req, res, next) => {
    const host = hostnameOf(req.get('host'));
    if (!allowed.has(host)) {
      return res.status(403).json({ success: false, error: 'Host not allowed' });
    }

    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        let originHost = null;
        try {
          originHost = hostnameOf(new URL(origin).host);
        } catch (_error) {
          originHost = null;
        }
        if (!originHost || !allowed.has(originHost)) {
          return res.status(403).json({ success: false, error: 'Cross-origin request refused' });
        }
      }
    }

    if (apiKey && isProtectedPath(req.path) && !apiKeyMatches(extractApiKey(req), apiKey)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    return next();
  };
}

module.exports = {
  apiKeyMatches,
  extractApiKey,
  allowedHostnames,
  hostnameOf,
  isLoopbackHost,
  isProtectedPath,
  securityMiddleware
};
