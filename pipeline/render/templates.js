/**
 * Scene templates (fork addition). Each scene is a self-contained 1920x1080
 * HTML page with a deterministic animation clock: `window.__seek(seconds)`
 * sets every element's state for that moment, so frames can be captured
 * exactly and reproducibly. All brief text is escaped (CLAUDE.md rule 3).
 */
const { escapeHtml, safeCssColor } = require('../../utils/html-escape');

const FONT_STACK = "'Noto Sans', 'Noto Sans Devanagari', 'Noto Sans Kannada', 'Noto Sans Tamil', 'Noto Sans Telugu', 'Noto Sans Bengali', sans-serif";

function baseCss(theme) {
  const c = name => safeCssColor(theme[name], '#ffffff');
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1920px; height: 1080px; overflow: hidden; }
  body { background: ${c('bg')}; color: ${c('text')}; font-family: ${FONT_STACK}; }
  .bg { position: absolute; inset: 0; background:
      radial-gradient(1200px 700px at 85% -10%, ${c('accent')}22, transparent 60%),
      radial-gradient(900px 600px at -10% 110%, ${c('accent2')}1c, transparent 60%), ${c('bg')}; }
  .frame { position: absolute; inset: 70px 110px 110px 110px; display: flex; flex-direction: column; justify-content: center; }
  .brand { position: absolute; left: 110px; bottom: 44px; font-size: 28px; font-weight: 700; letter-spacing: 1px; color: ${c('muted')}; }
  .brand b { color: ${c('accent')}; }
  .src { position: absolute; right: 110px; bottom: 46px; font-size: 24px; color: ${c('muted')}; max-width: 1200px; text-align: right; }
  .kicker { font-size: 36px; font-weight: 800; letter-spacing: 6px; color: ${c('accent')}; margin-bottom: 28px; }
  h1 { font-size: 104px; line-height: 1.12; font-weight: 800; max-width: 1500px; }
  h2 { font-size: 68px; line-height: 1.15; font-weight: 800; margin-bottom: 44px; }
  .sub { font-size: 46px; color: ${c('muted')}; margin-top: 34px; max-width: 1400px; line-height: 1.3; }
  .rule { width: 160px; height: 10px; border-radius: 5px; background: ${c('accent')}; margin-bottom: 40px; }
  .list { display: flex; flex-direction: column; gap: 26px; }
  .item { display: flex; align-items: center; gap: 34px; background: ${c('panel')}; border-radius: 22px; padding: 28px 40px; font-size: 52px; font-weight: 600; line-height: 1.2; border-left: 12px solid ${c('accent2')}; }
  .item .badge { flex: 0 0 auto; width: 84px; height: 84px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 44px; font-weight: 800; background: ${c('accent2')}; color: ${c('bg')}; }
  .redflags .item { border-left-color: ${c('accent')}; }
  .redflags .badge { background: ${c('accent')}; color: #fff; border-radius: 16px; }
  .checklist .item { border-left-color: #3ddc97; }
  .checklist .badge { background: #3ddc97; color: ${c('bg')}; }
  .stat { font-size: 220px; font-weight: 900; line-height: 1; color: ${c('accent2')}; letter-spacing: -4px; }
  .statlabel { font-size: 56px; margin-top: 36px; max-width: 1500px; line-height: 1.25; font-weight: 600; }
  .chart { display: flex; align-items: flex-end; gap: 70px; height: 560px; padding: 0 30px; border-bottom: 5px solid ${c('muted')}; }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
  .bar { width: 100%; max-width: 300px; border-radius: 18px 18px 0 0; background: linear-gradient(180deg, ${c('accent2')}, ${c('accent')}); transform-origin: bottom; }
  .val { font-size: 58px; font-weight: 800; margin-bottom: 16px; }
  .labels { display: flex; gap: 70px; padding: 18px 30px 0; }
  .labels div { flex: 1; text-align: center; font-size: 46px; font-weight: 700; color: ${c('muted')}; }
  .quote { font-size: 80px; line-height: 1.22; font-weight: 800; max-width: 1560px; }
  .quote::before { content: '“'; display: block; font-size: 220px; line-height: 0.6; color: ${c('accent')}; margin-bottom: 30px; }
  .attr { font-size: 40px; color: ${c('muted')}; margin-top: 44px; }
  .center { align-items: center; text-align: center; }
  .center .rule { margin-left: auto; margin-right: auto; }
  [data-at] { will-change: transform, opacity; }
  `;
}

const ENGINE = `
  const ease = p => 1 - Math.pow(1 - p, 3);
  window.__seek = function (t) {
    document.querySelectorAll('[data-at]').forEach(function (el) {
      var at = parseFloat(el.dataset.at), dur = parseFloat(el.dataset.dur || '0.5'), fx = el.dataset.fx || 'up';
      var p = Math.min(1, Math.max(0, (t - at) / dur)), e = ease(p);
      if (fx === 'grow') { el.style.transform = 'scaleY(' + e + ')'; el.style.opacity = p > 0 ? 1 : 0; }
      else if (fx === 'pop') { el.style.opacity = e; el.style.transform = 'scale(' + (0.82 + 0.18 * e) + ')'; }
      else if (fx === 'fade') { el.style.opacity = e; }
      else { el.style.opacity = e; el.style.transform = 'translateY(' + (46 * (1 - e)) + 'px)'; }
    });
  };
  window.__seek(0);
`;

const attr = (at, fx = 'up', dur = 0.5) => `data-at="${Number(at).toFixed(3)}" data-dur="${dur}" data-fx="${fx}"`;

/**
 * Times (seconds from the scene's visual start) at which list items or bars appear.
 * Uses `revealAt` sentence indexes when given, else spreads items over the sentences.
 */
function revealTimes(count, sentenceStarts, revealAt, first = 0.5) {
  const times = [];
  for (let index = 0; index < count; index++) {
    let sentence;
    if (Array.isArray(revealAt) && Number.isInteger(revealAt[index])) sentence = revealAt[index];
    else if (sentenceStarts.length > count) sentence = index + 1;
    else sentence = Math.round((index * (sentenceStarts.length - 1)) / Math.max(1, count - 1));
    const at = sentenceStarts[Math.min(sentence, sentenceStarts.length - 1)];
    const previous = times[index - 1] ?? -1;
    times.push(Math.max(at ?? first + index * 0.6, previous + 0.35, index === 0 ? first : 0));
  }
  return times;
}

function sceneBody(visual, ctx) {
  const e = escapeHtml;
  const starts = ctx.sentenceStarts;
  switch (visual.type) {
    case 'title':
      return `<div class="frame">
        ${visual.kicker ? `<div class="kicker" ${attr(0.05)}>${e(visual.kicker)}</div>` : ''}
        <div class="rule" ${attr(0.15, 'fade')}></div>
        <h1 ${attr(0.25, 'up', 0.6)}>${e(visual.headline)}</h1>
        ${visual.sub ? `<div class="sub" ${attr(Math.max(1.0, starts[2] ?? 1.0))}>${e(visual.sub)}</div>` : ''}
      </div>`;
    case 'stat':
      return `<div class="frame">
        <div class="stat" ${attr(Math.max(0.3, (starts[1] ?? 0.6) - 0.1), 'pop', 0.6)}>${e(visual.value)}</div>
        <div class="statlabel" ${attr(Math.max(0.9, (starts[1] ?? 0.6) + 0.5))}>${e(visual.label)}</div>
      </div>`;
    case 'bars': {
      const max = Math.max(...visual.bars.map(bar => bar.value)) || 1;
      const times = revealTimes(visual.bars.length, starts, visual.revealAt);
      return `<div class="frame">
        <h2 ${attr(0.1)} style="font-size:54px">${e(visual.heading)}</h2>
        <div class="chart">${visual.bars.map((bar, index) => `<div class="col">
            <div class="val" ${attr(times[index] + 0.55, 'fade', 0.3)}>${e(bar.display || String(bar.value))}</div>
            <div class="bar" style="height:${Math.max(3, (bar.value / max) * 82).toFixed(2)}%" ${attr(times[index], 'grow', 0.8)}></div>
          </div>`).join('')}</div>
        <div class="labels">${visual.bars.map(bar => `<div>${e(bar.label)}</div>`).join('')}</div>
      </div>`;
    }
    case 'bullets':
    case 'steps':
    case 'redflags':
    case 'checklist': {
      const times = revealTimes(visual.items.length, starts, visual.revealAt);
      const badge = index => (visual.type === 'steps' ? String(index + 1) : visual.type === 'redflags' ? '!' : visual.type === 'checklist' ? '✓' : '•');
      const size = visual.items.length >= 5 ? 'font-size:46px;padding:22px 36px' : '';
      return `<div class="frame ${visual.type}">
        <h2 ${attr(0.1)}>${e(visual.heading)}</h2>
        <div class="list">${visual.items.map((item, index) => `<div class="item" style="${size}" ${attr(times[index])}><div class="badge">${badge(index)}</div><div>${e(item)}</div></div>`).join('')}</div>
      </div>`;
    }
    case 'quote':
      return `<div class="frame">
        <div class="quote" ${attr(0.2, 'up', 0.6)}>${e(visual.text)}</div>
        ${visual.attribution ? `<div class="attr" ${attr(Math.max(1.2, starts[1] ?? 1.2))}>— ${e(visual.attribution)}</div>` : ''}
      </div>`;
    case 'outro':
      return `<div class="frame center">
        <div class="rule" ${attr(0.1, 'fade')}></div>
        <h1 ${attr(0.2, 'up', 0.6)}>${e(visual.headline)}</h1>
        ${visual.sub ? `<div class="sub" ${attr(Math.max(1.0, starts[1] ?? 1.0))}>${e(visual.sub)}</div>` : ''}
      </div>`;
    default:
      throw new Error(`Unknown visual type: ${visual.type}`);
  }
}

/**
 * @param {object} scene brief scene
 * @param {object} channel channel config
 * @param {{ sentenceStarts: number[] }} ctx seconds from the scene's visual start
 */
function sceneHtml(scene, channel, ctx) {
  const note = scene.visual.note || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${baseCss(channel.theme)}</style></head><body>
    <div class="bg"></div>
    ${sceneBody(scene.visual, ctx)}
    <div class="brand" ${attr(0, 'fade', 0.3)}><b>${escapeHtml(channel.name)}</b></div>
    ${note ? `<div class="src" ${attr(0.8, 'fade', 0.4)}>${escapeHtml(note)}</div>` : ''}
    <script>${ENGINE}</script></body></html>`;
}

/** 1280x720 thumbnail. */
function thumbnailHtml({ text, title, channel }) {
  const theme = channel.theme;
  const c = name => safeCssColor(theme[name], '#ffffff');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1280px; height: 720px; overflow: hidden; }
    body { font-family: ${FONT_STACK}; color: ${c('text')}; background: radial-gradient(900px 600px at 100% 0%, ${c('accent')}55, transparent 60%), ${c('bg')}; }
    .wrap { position: absolute; inset: 50px 60px; display: flex; flex-direction: column; justify-content: center; }
    .big { font-size: 150px; font-weight: 900; line-height: 0.98; color: ${c('accent2')}; letter-spacing: -3px; text-transform: uppercase; }
    .t { font-size: 46px; font-weight: 700; margin-top: 30px; max-width: 1000px; line-height: 1.2; }
    .brand { position: absolute; left: 60px; bottom: 36px; font-size: 34px; font-weight: 800; color: ${c('accent')}; }
    .bar { position: absolute; left: 0; top: 0; bottom: 0; width: 22px; background: ${c('accent')}; }
  </style></head><body><div class="bar"></div><div class="wrap"><div class="big">${escapeHtml(text)}</div><div class="t">${escapeHtml(title)}</div></div><div class="brand">${escapeHtml(channel.name)}</div></body></html>`;
}

module.exports = { sceneHtml, thumbnailHtml, revealTimes };
