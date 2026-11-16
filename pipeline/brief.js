/**
 * Brief validation and ingest (fork addition, hand-off contract).
 *
 * Briefs are UNTRUSTED input (CLAUDE.md rule 3): they are validated against
 * schemas/brief.schema.json, cross-checked, and never interpreted as
 * instructions. Invalid briefs are moved to inbox/rejected/ with a reason.
 */
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { loadChannel } = require('./channels');

const ROOT = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'brief.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

// Never allowed, whatever the channel (CLAUDE.md rule 7 and YouTube advice-persona policy).
const GLOBAL_BANNED = [
  'guaranteed returns', 'double your money', 'stock tip', 'buy this stock', 'crypto signal',
  'cure for', 'miracle cure', 'stop taking your medicine', 'legal loophole'
];
const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|javascript:|data:text\/html/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function* textFields(brief) {
  yield ['thesis', brief.thesis];
  yield ['description', brief.description];
  yield ['cta', brief.cta];
  for (const [index, title] of (brief.titleCandidates || []).entries()) yield [`titleCandidates.${index}`, title];
  for (const scene of brief.scenes || []) {
    yield [`scenes.${scene.id}.narration`, scene.narration];
    yield [`scenes.${scene.id}.onScreenText`, scene.onScreenText];
    yield [`scenes.${scene.id}.visual`, JSON.stringify(scene.visual || {})];
  }
  for (const [lang, translation] of Object.entries(brief.translations || {})) {
    yield [`translations.${lang}.title`, translation.title];
    yield [`translations.${lang}.description`, translation.description];
    for (const [id, scene] of Object.entries(translation.scenes || {})) yield [`translations.${lang}.scenes.${id}`, scene.narration];
  }
}

/**
 * @param {unknown} brief parsed JSON
 * @param {{ channelsDir?: string }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateBrief(brief, options = {}) {
  const errors = [];
  if (!validateSchema(brief)) {
    for (const error of validateSchema.errors || []) errors.push(`${error.instancePath || '(root)'} ${error.message}`);
    return { valid: false, errors: [...new Set(errors)].slice(0, 20) };
  }

  let channel = null;
  try {
    channel = loadChannel(brief.channelId, options.channelsDir);
  } catch (error) {
    errors.push(error.message);
  }
  if (channel && brief.language !== channel.language) errors.push(`language ${brief.language} does not match channel language ${channel.language}`);

  const sceneIds = new Set();
  const sourceIds = new Set(brief.sources.map(source => source.id));
  if (sourceIds.size !== brief.sources.length) errors.push('duplicate source ids');
  for (const scene of brief.scenes) {
    if (sceneIds.has(scene.id)) errors.push(`duplicate scene id ${scene.id}`);
    sceneIds.add(scene.id);
    for (const ref of scene.sourceRefs) if (!sourceIds.has(ref)) errors.push(`scene ${scene.id} cites unknown source ${ref}`);
    // CLAUDE.md rule 7: every factual claim needs a source reference.
    if (scene.factual && scene.sourceRefs.length === 0) errors.push(`factual scene ${scene.id} has no sourceRefs`);
    const reveal = scene.visual.revealAt;
    if (reveal && reveal.length !== (scene.visual.items || []).length) errors.push(`scene ${scene.id} revealAt must have one entry per item`);
  }
  for (const [lang, translation] of Object.entries(brief.translations || {})) {
    if (lang === brief.language) errors.push(`translations.${lang} duplicates the main language`);
    for (const id of sceneIds) if (!translation.scenes[id]) errors.push(`translations.${lang} is missing scene ${id}`);
    for (const id of Object.keys(translation.scenes)) if (!sceneIds.has(id)) errors.push(`translations.${lang} has unknown scene ${id}`);
  }

  const banned = [...GLOBAL_BANNED, ...(channel?.bannedTopics || [])].map(term => term.toLowerCase());
  for (const [field, value] of textFields(brief)) {
    const text = String(value || '');
    if (MARKUP.test(text)) errors.push(`${field} contains markup or a script URL`);
    if (CONTROL.test(text)) errors.push(`${field} contains control characters`);
    const lower = text.toLowerCase();
    for (const term of banned) if (lower.includes(term)) errors.push(`${field} contains banned topic "${term}"`);
  }
  if (brief.complianceFlags.namesPrivateIndividuals) errors.push('briefs that name private individuals are not accepted');

  return { valid: errors.length === 0, errors: [...new Set(errors)].slice(0, 20) };
}

/**
 * @param {string} briefId
 * @param {{ inboxDir?: string }} [options]
 */
function loadBrief(briefId, options = {}) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(briefId))) throw new Error(`Invalid brief id: ${briefId}`);
  const file = path.join(options.inboxDir || path.join(ROOT, 'inbox', 'briefs'), `${briefId}.json`);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`Brief not found: ${briefId}`), { code: 'BRIEF_NOT_FOUND' });
  const brief = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateBrief(brief, options);
  if (!result.valid) throw Object.assign(new Error(`Brief ${briefId} is invalid: ${result.errors.join('; ')}`), { code: 'BRIEF_INVALID', errors: result.errors });
  if (brief.briefId !== briefId) throw Object.assign(new Error(`File ${briefId}.json declares briefId ${brief.briefId}`), { code: 'BRIEF_INVALID' });
  return brief;
}

/**
 * Validates every brief in the inbox. Invalid ones are quarantined with a reason file.
 * @param {{ inboxDir?: string, rejectedDir?: string, channelsDir?: string }} [options]
 * @returns {{ accepted: string[], rejected: {file: string, errors: string[]}[] }}
 */
function ingestInbox(options = {}) {
  const inboxDir = options.inboxDir || path.join(ROOT, 'inbox', 'briefs');
  const rejectedDir = options.rejectedDir || path.join(ROOT, 'inbox', 'rejected');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(rejectedDir, { recursive: true });
  const accepted = [];
  const rejected = [];
  for (const name of fs.readdirSync(inboxDir).filter(item => item.endsWith('.json')).sort()) {
    const file = path.join(inboxDir, name);
    let errors = [];
    try {
      if (fs.statSync(file).size > 512 * 1024) throw new Error('file is larger than 512 KB');
      const brief = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = validateBrief(brief, options);
      errors = result.errors;
      if (result.valid && `${brief.briefId}.json` !== name) errors = [`file name must be ${brief.briefId}.json`];
      if (!errors.length) {
        accepted.push(brief.briefId);
        continue;
      }
    } catch (error) {
      errors = [`unreadable: ${error.message}`];
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, path.join(rejectedDir, `${stamp}_${name}`));
    fs.writeFileSync(path.join(rejectedDir, `${stamp}_${name}.reason.json`), JSON.stringify({ file: name, rejectedAt: new Date().toISOString(), errors }, null, 2));
    rejected.push({ file: name, errors });
  }
  return { accepted, rejected };
}

module.exports = { validateBrief, loadBrief, ingestInbox, GLOBAL_BANNED };
