/**
 * Cost ledger (fork addition, CLAUDE.md rule 4).
 *
 * Every paid call is checked BEFORE it is made (`assertBudget`) and recorded
 * after (`record`). Totals live in ops/cost-ledger.json. A breach throws
 * COST_CAP_EXCEEDED, which job mode reports as "needs human" (exit 10).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRICES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'prices.json'), 'utf8'));

class CostCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CostCapError';
    this.code = 'COST_CAP_EXCEEDED';
    this.status = 402;
  }
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

class CostLedger {
  /**
   * @param {{ file?: string, monthlyCapUsd?: number, perVideoCapUsd?: number, now?: () => Date }} [options]
   */
  constructor(options = {}) {
    this.file = options.file || process.env.COST_LEDGER_PATH || path.join(ROOT, 'ops', 'cost-ledger.json');
    this.monthlyCapUsd = options.monthlyCapUsd ?? (Number(process.env.COST_MONTHLY_CAP_USD) || PRICES.caps.monthlyUsd);
    this.perVideoCapUsd = options.perVideoCapUsd ?? (Number(process.env.COST_PER_VIDEO_CAP_USD) || PRICES.caps.perVideoUsd);
    this.now = options.now || (() => new Date());
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_error) {
      return { schemaVersion: 1, pricesLastVerified: PRICES.lastVerified, months: {}, videos: {}, calls: [] };
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }

  totals(videoId = null) {
    const data = this.read();
    return {
      monthUsd: data.months[monthKey(this.now())]?.usd || 0,
      videoUsd: videoId ? (data.videos[videoId]?.usd || 0) : 0,
      monthlyCapUsd: this.monthlyCapUsd,
      perVideoCapUsd: this.perVideoCapUsd
    };
  }

  /**
   * Throws if spending `estimateUsd` more would pass a cap.
   * @param {{ videoId?: string|null, estimateUsd: number, what: string }} input
   */
  assertBudget({ videoId = null, estimateUsd, what }) {
    if (!(estimateUsd >= 0)) throw new Error('estimateUsd must be a non-negative number');
    const totals = this.totals(videoId);
    if (totals.monthUsd + estimateUsd > this.monthlyCapUsd) {
      throw new CostCapError(`Monthly cost cap reached: $${totals.monthUsd.toFixed(4)} spent of $${this.monthlyCapUsd}; refused ${what} (~$${estimateUsd.toFixed(4)})`);
    }
    if (videoId && totals.videoUsd + estimateUsd > this.perVideoCapUsd) {
      throw new CostCapError(`Per-video cost cap reached for ${videoId}: $${totals.videoUsd.toFixed(4)} of $${this.perVideoCapUsd}; refused ${what} (~$${estimateUsd.toFixed(4)})`);
    }
  }

  /**
   * @param {{ provider: string, model?: string|null, task: string, videoId?: string|null, inputTokens?: number, outputTokens?: number, units?: number, usd: number }} call
   */
  record(call) {
    if (!(call.usd >= 0)) throw new Error('usd must be a non-negative number');
    const data = this.read();
    const month = monthKey(this.now());
    data.months[month] = data.months[month] || { usd: 0, calls: 0, byProvider: {} };
    data.months[month].usd = Number((data.months[month].usd + call.usd).toFixed(6));
    data.months[month].calls += 1;
    data.months[month].byProvider[call.provider] = Number(((data.months[month].byProvider[call.provider] || 0) + call.usd).toFixed(6));
    if (call.videoId) {
      data.videos[call.videoId] = data.videos[call.videoId] || { usd: 0, calls: 0 };
      data.videos[call.videoId].usd = Number((data.videos[call.videoId].usd + call.usd).toFixed(6));
      data.videos[call.videoId].calls += 1;
    }
    data.calls.push({ at: this.now().toISOString(), ...call });
    if (data.calls.length > 2000) data.calls = data.calls.slice(-2000);
    data.pricesLastVerified = PRICES.lastVerified;
    this.write(data);
    return this.totals(call.videoId);
  }
}

/** USD for a Gemini TTS call from token counts (falls back to a per-second estimate). */
function geminiTtsUsd({ inputTokens = 0, outputTokens = null, seconds = 0 }) {
  const price = PRICES.providers['gemini-tts'];
  const out = outputTokens ?? Math.ceil(seconds * price.assumedAudioTokensPerSecond);
  return (inputTokens * price.inputUsd + out * price.outputUsd) / 1e6;
}

module.exports = { CostLedger, CostCapError, geminiTtsUsd, PRICES };
