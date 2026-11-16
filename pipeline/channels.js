/**
 * Channel configuration (fork addition). One JSON file per channel in channels/.
 * Language, voices, theme and schedule are data, so adding a channel or a
 * language never needs a code change.
 */
const fs = require('fs');
const path = require('path');
const { z } = require('zod');

const CHANNELS_DIR = path.join(__dirname, '..', 'channels');
const LANG = z.enum(['en', 'hi', 'kn', 'ta', 'te', 'bn', 'mr']);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const channelSchema = z.object({
  channelId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(60),
  handle: z.string().regex(/^@[A-Za-z0-9._-]{3,30}$/),
  tagline: z.partialRecord(LANG, z.string().max(120)),
  language: LANG,
  dubLanguages: z.array(LANG).max(6).default([]),
  categoryId: z.string().regex(/^\d{1,3}$/).default('27'),
  defaultPrivacyAfterApproval: z.enum(['private', 'unlisted', 'public']).default('private'),
  theme: z.object({ bg: color, panel: color, accent: color, accent2: color, text: color, muted: color }),
  voice: z.record(z.string(), z.partialRecord(LANG, z.string().max(60))),
  narrationStyle: z.partialRecord(LANG, z.string().max(300)).default({}),
  burnSubtitles: z.boolean().default(false),
  bannedTopics: z.array(z.string().max(60)).default([]),
  youtube: z.object({ channelIdOnYouTube: z.string().nullable() }).default({ channelIdOnYouTube: null })
}).strict();

/**
 * @param {string} channelId
 * @param {string} [dir]
 * @returns {z.infer<typeof channelSchema>}
 */
function loadChannel(channelId, dir = CHANNELS_DIR) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(channelId))) throw new Error(`Invalid channel id: ${channelId}`);
  const file = path.join(dir, `${channelId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown channel: ${channelId}`);
  const parsed = channelSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid channel config ${channelId}: ${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  if (parsed.data.channelId !== channelId) throw new Error(`Channel file ${channelId}.json declares a different channelId`);
  return parsed.data;
}

function listChannels(dir = CHANNELS_DIR) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => loadChannel(name.replace(/\.json$/, ''), dir));
}

module.exports = { loadChannel, listChannels, channelSchema };
