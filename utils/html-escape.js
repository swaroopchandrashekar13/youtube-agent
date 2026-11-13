/**
 * Escaping helpers for model- or brief-generated text that is placed into
 * HTML (Playwright renders) or SVG (sharp/librsvg renders). Fork rule 3:
 * untrusted text must stay text, never markup or script.
 */

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;'
};

/**
 * Escapes text for HTML/XML element content and quoted attribute values.
 * Also strips C0 control characters other than tab/newline, which are invalid in XML.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"'`]/g, char => ENTITIES[char]);
}

const SAFE_CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}( [a-z]{3,20})?)$/i;

/**
 * Returns the color only if it is a hex color or a plain color name; otherwise the fallback.
 * Prevents CSS injection through model-chosen colors.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function safeCssColor(value, fallback = 'white') {
  const text = String(value ?? '').trim();
  return SAFE_CSS_COLOR.test(text) ? text : fallback;
}

/**
 * Allows only data: URLs for images embedded in render templates.
 * @param {unknown} value
 * @returns {string}
 */
function safeDataImageUrl(value) {
  const text = String(value ?? '');
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : '';
}

module.exports = { escapeHtml, safeCssColor, safeDataImageUrl };
