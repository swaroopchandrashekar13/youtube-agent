/**
 * TTS providers (fork addition). Each provider implements:
 *
 *   synthesize({ text, language, voice, style, outPath }) -> { wavPath, usage? }
 *
 * and writes a WAV file. Providers that cost money expose `estimateUsd`.
 * `draft: true` marks placeholder voices that may never be published.
 */
const { execFile } = require('child_process');
const fs = require('fs').promises;
const { promisify } = require('util');
const { runFFmpeg } = require('../../utils/ffmpeg');
const { synthesizeFakeNarration } = require('../../utils/fake-providers');
const { geminiTtsUsd, PRICES } = require('../cost-ledger');

const execFileAsync = promisify(execFile);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function fetchJson(url, options, { timeoutMs, retries = 2 }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.text();
      if (response.ok) return JSON.parse(body);
      const error = new Error(`HTTP ${response.status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
      error.status = response.status;
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (error.status && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      lastError = error;
    }
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
  }
  throw lastError;
}

let cachedGeminiModel = null;

/** Resolves the TTS model at runtime (rule 9): env override, else the newest flash TTS model the API lists. */
async function resolveGeminiTtsModel(apiKey) {
  if (process.env.GEMINI_TTS_MODEL) return process.env.GEMINI_TTS_MODEL;
  if (cachedGeminiModel) return cachedGeminiModel;
  const data = await fetchJson(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } }, { timeoutMs: 20000 });
  const names = (data.models || []).map(model => String(model.name || '').replace(/^models\//, '')).filter(name => /tts/i.test(name));
  if (!names.length) throw new Error('The Gemini API lists no TTS model for this key');
  const version = name => (name.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
  names.sort((a, b) => (/flash/i.test(b) - /flash/i.test(a)) || (version(b) - version(a)) || (/preview/i.test(a) - /preview/i.test(b)));
  cachedGeminiModel = names[0];
  return cachedGeminiModel;
}

const providers = {
  gemini: {
    name: 'gemini',
    draft: false,
    available: () => Boolean(process.env.GEMINI_API_KEY),
    estimateUsd: text => geminiTtsUsd({ inputTokens: Math.ceil(text.length / 3), seconds: Math.ceil(text.split(/\s+/).length / 2) }),
    async synthesize({ text, voice, style, outPath }) {
      const apiKey = process.env.GEMINI_API_KEY;
      const model = await resolveGeminiTtsModel(apiKey);
      const prompt = style ? `${style.replace(/[.:\s]+$/, '')}:\n${text}` : text;
      const data = await fetchJson(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } }
          }
        })
      }, { timeoutMs: 180000 });
      const part = data.candidates?.[0]?.content?.parts?.find(item => item.inlineData?.data);
      if (!part) throw new Error(`Gemini TTS returned no audio (finishReason: ${data.candidates?.[0]?.finishReason || 'unknown'})`);
      const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1]) || 24000;
      const pcm = `${outPath}.pcm`;
      await fs.writeFile(pcm, Buffer.from(part.inlineData.data, 'base64'));
      await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', pcm, '-ar', '48000', outPath]);
      await fs.rm(pcm, { force: true });
      const usage = data.usageMetadata || {};
      return {
        wavPath: outPath,
        model,
        usage: { inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount ?? null }
      };
    },
    usd: ({ usage, seconds }) => geminiTtsUsd({ inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens ?? null, seconds })
  },

  sarvam: {
    name: 'sarvam',
    draft: false,
    available: () => Boolean(process.env.SARVAM_API_KEY),
    estimateUsd: text => (text.length / 10000) * PRICES.providers['sarvam-tts'].usd,
    async synthesize({ text, language, voice, outPath }) {
      // Field names follow Sarvam's public REST docs; verify against docs.sarvam.ai before first paid use.
      const chunks = text.match(/[\s\S]{1,450}(?=\s|$)/g) || [text];
      const data = await fetchJson('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: chunks, target_language_code: `${language}-IN`, speaker: voice, model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3', speech_sample_rate: 24000 })
      }, { timeoutMs: 120000 });
      const audios = data.audios || [];
      if (!audios.length) throw new Error('Sarvam TTS returned no audio');
      const parts = [];
      for (const [index, audio] of audios.entries()) {
        const part = `${outPath}.${index}.wav`;
        await fs.writeFile(part, Buffer.from(audio, 'base64'));
        parts.push(part);
      }
      const inputs = parts.flatMap(part => ['-i', part]);
      await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', `concat=n=${parts.length}:v=0:a=1`, '-ar', '48000', '-ac', '1', outPath]);
      for (const part of parts) await fs.rm(part, { force: true });
      return { wavPath: outPath, model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3', usage: { characters: text.length } };
    },
    usd: ({ usage }) => ((usage?.characters || 0) / 10000) * PRICES.providers['sarvam-tts'].usd
  },

  // Robotic offline voice. Good enough to review visuals and timing; never publishable.
  espeak: {
    name: 'espeak',
    draft: true,
    available: () => true,
    estimateUsd: () => 0,
    async synthesize({ text, voice, outPath }) {
      const raw = `${outPath}.raw.wav`;
      await execFileAsync('espeak-ng', ['-v', voice || 'en-gb', '-s', '150', '-w', raw, text], { timeout: 120000 });
      await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, '-ar', '48000', '-ac', '1', outPath]);
      await fs.rm(raw, { force: true });
      return { wavPath: outPath, model: 'espeak-ng', usage: {} };
    },
    usd: () => 0
  },

  fake: {
    name: 'fake',
    draft: true,
    available: () => true,
    estimateUsd: () => 0,
    async synthesize({ text, outPath }) {
      await synthesizeFakeNarration(text, outPath);
      return { wavPath: outPath, model: 'ffmpeg-sine', usage: {} };
    },
    usd: () => 0
  }
};

/**
 * Picks the provider for a language: TTS_PROVIDER (or TTS_PROVIDER_<LANG>) if set,
 * else the first available real provider, else the draft voice.
 * @param {string} language
 */
function selectProvider(language) {
  if (String(process.env.PROVIDERS_MODE).toLowerCase() === 'fake') return providers.fake;
  const wanted = process.env[`TTS_PROVIDER_${language.toUpperCase()}`] || process.env.TTS_PROVIDER;
  if (wanted) {
    const provider = providers[wanted];
    if (!provider) throw new Error(`Unknown TTS provider: ${wanted}`);
    if (!provider.available()) throw new Error(`TTS provider ${wanted} is not configured (missing API key)`);
    return provider;
  }
  for (const name of language === 'en' ? ['gemini'] : ['gemini', 'sarvam']) if (providers[name].available()) return providers[name];
  return providers.espeak;
}

module.exports = { providers, selectProvider, resolveGeminiTtsModel };
