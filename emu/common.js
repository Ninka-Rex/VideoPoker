// Shared browser helpers for the IGT emulator pages: persistent storage, audio output,
// and the small VM info panel shown under the controls.
'use strict';
(function () {
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(undefined), ms))]);

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('igt-emu', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) {
  try {
    const db = await withTimeout(idb(), 2000); if (!db) return undefined;
    return await withTimeout(new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); }), 3000);
  } catch (e) { return undefined; }
}
async function kvSet(k, v) {
  try { const db = await withTimeout(idb(), 2000); if (db) db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {}
}

// ---- audio: the machines hand over 735 stereo samples per 60 Hz frame ----
const WORKLET = `
class IGTOut extends AudioWorkletProcessor {
  constructor() { super(); this.q = []; this.cur = null; this.pos = 0; this.under = 0; this.port.onmessage = e => { this.q.push(e.data); if (this.q.length > 8) this.q.splice(0, this.q.length - 4); }; }
  process(_, outputs) {
    const [L, R] = outputs[0];
    for (let i = 0; i < L.length; i++) {
      if (!this.cur || this.pos >= this.cur.length) { this.cur = this.q.shift() || null; this.pos = 0; if (!this.cur) this.under++; }
      if (this.cur) { L[i] = this.cur[this.pos]; R[i] = this.cur[this.pos + 1]; this.pos += 2; } else { L[i] = R[i] = 0; }
    }
    return true;
  }
}
registerProcessor('igt-out', IGTOut);`;
const audio = { ctx: null, node: null, gain: null, samples: 0 };
// volume 0-100, shared by every machine page; stored per browser
const VOL_KEY = 'igt-volume';
let volume = 100;
try { const v = parseInt(localStorage.getItem(VOL_KEY), 10); if (v >= 0 && v <= 100) volume = v; } catch (e) {}
const volGain = v => (v / 100) * (v / 100);   // squared, so the slider feels even to the ear
function setVolume(v) {
  volume = Math.max(0, Math.min(100, Math.round(v)));
  try { localStorage.setItem(VOL_KEY, String(volume)); } catch (e) {}
  if (audio.gain) audio.gain.gain.setTargetAtTime(volGain(volume), audio.ctx.currentTime, 0.02);
  document.querySelectorAll('.volume').forEach(el => { const r = el.querySelector('input'), o = el.querySelector('output');
    if (r && +r.value !== volume) r.value = volume; if (o) o.textContent = volume ? volume + '%' : 'muted'; });
}
async function startAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  try {
    const ctx = new AudioContext({ sampleRate: 44100 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'igt-out', { outputChannelCount: [2] });
    const gain = ctx.createGain(); gain.gain.value = volGain(volume);
    node.connect(gain); gain.connect(ctx.destination);
    audio.ctx = ctx; audio.node = node; audio.gain = gain;
  } catch (e) { console.log('audio unavailable', e); }
}
function pushAudio(L, R) {
  if (!audio.ctx || audio.ctx.state !== 'running') return;
  const buf = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { buf[i * 2] = L[i]; buf[i * 2 + 1] = R[i]; }
  audio.samples += L.length;
  audio.node.port.postMessage(buf, [buf.buffer]);
}
if (!window.NO_COMMON_AUDIO) ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, startAudio));
// fills every <div class="volume"> on the page with a slider; other tabs follow changes
function volumeSliders() {
  document.querySelectorAll('div.volume').forEach(el => {
    if (el.querySelector('input')) return;
    const r = document.createElement('input'); r.type = 'range'; r.min = 0; r.max = 100; r.step = 1; r.value = volume; r.title = 'Volume';
    const o = document.createElement('output');
    r.addEventListener('input', () => setVolume(+r.value));
    el.append(r, o);
  });
  setVolume(volume);
}
if (document.body) volumeSliders(); else document.addEventListener('DOMContentLoaded', volumeSliders);
window.addEventListener('storage', e => { if (e.key === VOL_KEY) { const v = parseInt(e.newValue, 10); if (v >= 0 && v <= 100) setVolume(v); } });

// ---- VM info panel ----
// rows: function returning [[label, value], ...] describing the machine; the panel adds
// frames-per-second and speed itself. Call tick(frameCount) once per emulated frame.
class InfoPanel {
  // Always shows fps / speed / load; everything else (CPU registers etc.) sits in a collapsed "details" row.
  constructor(el, rows, totals) {
    this.el = el; this.rows = rows; this.totals = totals;
    this.frames = 0; this.t0 = performance.now(); this.fps = 0; this.busy = 0; this.busyAcc = 0;
    if (!document.getElementById('igt-info-css')) {
      const s = document.createElement('style'); s.id = 'igt-info-css';
      s.textContent = '.info{margin-top:14px}.info details.quiet{margin-top:0}' +
        '.info .g{display:grid;grid-template-columns:max-content max-content max-content max-content;justify-content:start;gap:2px 12px}' +
        '.info .h{grid-column:1/-1;margin-top:6px;text-transform:uppercase;letter-spacing:.08em;font-size:9px}' +
        '.info summary{cursor:pointer;margin-top:6px;list-style:none;width:max-content}' +
        '.info summary::-webkit-details-marker{display:none}.info summary:hover{color:#6a6a6a}' +
        '.info summary::before{content:"▸ "}.info details[open] summary::before{content:"▾ "}' +
        '.info details .g{margin-top:4px}';
      document.head.append(s);
    }
    el.textContent = '';
    this.main = document.createElement('div'); this.main.className = 'g';
    const d = document.createElement('details'), sum = document.createElement('summary');
    sum.textContent = 'debug';
    this.more = document.createElement('div'); this.more.className = 'g';
    d.append(sum, this.more);
    // everything (speed, coins, debug) sits under one status dropdown, closed by default
    const o = document.createElement('details'), osum = document.createElement('summary');
    osum.textContent = 'Status and debug'; o.className = 'quiet';
    o.append(osum, this.main, d); el.append(o);
    // both start collapsed on every page load
    setInterval(() => this.refresh(), 500);
  }
  tick(frame, ms) { this.frames++; this.busyAcc += ms || 0; this.lastFrame = frame; }
  fill(el, rows) {
    el.textContent = '';
    for (const [k, v] of rows) {
      if (v === undefined) { const h = document.createElement('span'); h.className = 'h'; h.textContent = k; el.append(h); continue; }
      const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      el.append(a, b);
    }
  }
  // optional totals() -> { coinsIn, coinsOut } shown under the host load
  totalRows() {
    let t; try { t = this.totals && this.totals(); } catch (e) {}
    return t ? [['coins', (t.coinsIn || 0) + ' in · ' + (t.coinsOut || 0) + ' out' + (t.coinsReturned !== undefined ? ' · ' + t.coinsReturned + ' returned' : '')]] : [];
  }
  refresh() {
    const now = performance.now(), dt = (now - this.t0) / 1000;
    this.fps = this.frames / dt; this.busy = this.busyAcc / (dt * 1000) * 100;
    this.frames = 0; this.busyAcc = 0; this.t0 = now;
    this.fill(this.main, [['emulated fps', this.fps.toFixed(1) + ' / 60'],
      ['host load', this.busy.toFixed(0) + '%'], ['audio', audio.ctx ? audio.ctx.state : 'off (click page)']].concat(this.totalRows()));
    if (!this.more.parentNode.open) return;
    let rows = [];
    try { rows = this.rows(); } catch (e) { rows = [['error', e.message]]; }
    this.fill(this.more, rows);
  }
}
// ---- printed receipts / vouchers (shared by every machine page) ----
// new ReceiptsPanel(container, { key, redeem }) builds a collapsible "Receipts" list. add(text) stores a
// ticket (per-game, in IndexedDB). If opts.redeem(text) is given, each ticket gets an "Insert into bill
// acceptor" button and a .txt upload is offered (ticket in, ticket out).
class ReceiptsPanel {
  constructor(container, opts) {
    this.opts = opts || {}; this.list = []; this.key = null;
    if (!document.getElementById('igt-rcpt-css')) {
      const s = document.createElement('style'); s.id = 'igt-rcpt-css';
      s.textContent = '.receipts{margin-top:14px;font-size:11px}.receipts[hidden]{display:none}' +
        '.receipts summary{display:block;cursor:pointer;list-style:none;margin:0 0 6px;padding-bottom:3px;font:700 11px var(--sans);text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid rgba(255,255,255,.55)}' +
        '.receipts summary::-webkit-details-marker{display:none}' +
        '.receipts summary::before{content:"▸ "}.receipts[open] summary::before{content:"▾ "}' +
        '.receipts .bar{display:flex;gap:8px;margin:8px 0;flex-wrap:wrap}' +
        '.receipts button,.receipts label.btn{display:inline-block;padding:0 10px}' +
        '.receipts .ticket{margin-top:10px}.receipts .meta{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}' +
        '.receipts pre{margin:0;padding:12px 14px;font:11px/1.35 var(--mono);' +
        'overflow-x:auto;max-height:360px;overflow-y:auto;user-select:text;-webkit-user-select:text}' +
        '.receipts .msg{margin-left:4px}';
      document.head.append(s);
    }
    const d = this.box = document.createElement('details'); d.className = 'receipts'; d.hidden = true;
    this.sum = document.createElement('summary'); this.sum.textContent = 'Receipts';
    const bar = document.createElement('div'); bar.className = 'bar';
    const all = document.createElement('button'); all.textContent = 'Save all (.txt)';
    all.onclick = () => this.download('receipts.txt', this.list.slice().reverse()
      .map(r => new Date(r.t).toLocaleString() + '\n\n' + r.text).join('\n\n' + '-'.repeat(40) + '\n\n'));
    const clr = document.createElement('button'); clr.textContent = 'Clear';
    clr.onclick = () => { if (!confirm('Delete all saved receipts for this game?')) return; this.list = []; this.save(); this.draw(); };
    bar.append(all, clr);
    this.msg = document.createElement('span'); this.msg.className = 'msg';
    if (this.opts.redeem) {
      const up = document.createElement('label'); up.className = 'btn'; up.textContent = 'Insert ticket file (.txt)';
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,text/plain'; inp.hidden = true;
      inp.onchange = async () => { const f = inp.files[0]; inp.value = ''; if (f) this.redeem(await f.text()); };
      up.append(inp); bar.append(up);
      this.alwaysShow = true; d.hidden = false;
    }
    bar.append(this.msg);
    this.items = document.createElement('div');
    d.append(this.sum, bar, this.items);
    d.addEventListener('toggle', () => { if (d.open) this.mark(false); });
    container.append(d);
  }
  async load(key) {
    this.key = key; let v; try { v = await kvGet('receipts:' + key); } catch (e) {}
    this.list = Array.isArray(v) ? v : []; this.draw();
  }
  save() { if (this.key) kvSet('receipts:' + this.key, this.list); }
  add(text) {
    text = String(text).replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return;
    this.list.unshift({ t: Date.now(), text }); if (this.list.length > 100) this.list.length = 100;
    this.save(); this.draw(); this.mark(!this.box.open);
  }
  mark(fresh) {
    this.sum.textContent = 'Receipts (' + this.list.length + ')' + (fresh ? ' · new' : '');
    this.sum.classList.toggle('new', !!fresh);
  }
  redeem(text) {
    const r = this.opts.redeem(text);
    this.msg.textContent = r === true ? 'ticket inserted' : (r || 'not accepted');
    clearTimeout(this.msgT); this.msgT = setTimeout(() => { this.msg.textContent = ''; }, 4000);
  }
  fileName(r) {
    const d = new Date(r.t), p = n => String(n).padStart(2, '0');
    return 'receipt-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.txt';
  }
  download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text.replace(/\n/g, '\r\n')], { type: 'text/plain' }));
    a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  draw() {
    this.box.hidden = !this.list.length && !this.alwaysShow;
    this.mark(false);
    this.items.textContent = '';
    this.list.forEach((r, i) => {
      const el = document.createElement('div'); el.className = 'ticket';
      const meta = document.createElement('div'); meta.className = 'meta';
      const when = document.createElement('span'); when.textContent = new Date(r.t).toLocaleString();
      const sv = document.createElement('button'); sv.textContent = 'Save'; sv.onclick = () => this.download(this.fileName(r), r.text);
      const del = document.createElement('button'); del.textContent = 'Delete';
      del.onclick = () => { this.list.splice(i, 1); this.save(); this.draw(); };
      meta.append(when, sv);
      if (this.opts.redeem) { const ins = document.createElement('button'); ins.textContent = 'Insert into bill acceptor'; ins.onclick = () => this.redeem(r.text); meta.append(ins); }
      meta.append(del);
      const pre = document.createElement('pre'); pre.textContent = r.text;
      el.append(meta, pre); this.items.append(el);
    });
  }
}
const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n || 2, '0');
// ---- ROM library, straight from the bundle (bundle/*.js, made by build_bundle.js) so pages work from disk ----
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('cannot load ' + src)); document.head.append(s); });
}
async function library() {
  if (!window.LIBRARY) await loadScript('bundle/library.js');
  return window.LIBRARY;
}
// bytes of one library file (path as listed in the library)
async function romBytes(path) {
  const lib = await library();
  if (!(window.ROMDATA && window.ROMDATA[path])) await loadScript('bundle/' + lib.files[path]);
  const bin = atob(window.ROMDATA[path]), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  delete window.ROMDATA[path];
  return out;
}
// ---- light / dark switch (bottom right of every page) ----
// Pages opened from disk may each get their own localStorage, so the choice is kept in three places, each stamped with
// the time it was made, and the newest wins: localStorage, window.name (follows the tab) and a #igt-theme=... fragment
// added to the links that lead to another page of the site.
(function () {
  const KEY = 'igt-theme';
  const parse = str => { const m = /igt-theme[=:](dark|light)\.(\d+)/.exec(str || ''); return m ? { v: m[1], ts: +m[2] } : null; };
  const read = () => {
    let ls = null; try { ls = parse(KEY + ':' + localStorage.getItem(KEY)); } catch (e) {}
    const all = [parse(location.hash), parse(window.name), ls].filter(Boolean).sort((a, b) => b.ts - a.ts);
    return all.length ? all[0].v : 'light';
  };
  let stamp = '';
  const write = v => {
    stamp = v + '.' + Date.now();
    try { localStorage.setItem(KEY, stamp); } catch (e) {}
    window.name = (window.name || '').replace(/;?igt-theme=\w+\.\d+/, '') + ';igt-theme=' + stamp;
    try { history.replaceState(null, '', location.pathname + location.search + '#igt-theme=' + stamp); } catch (e) {}
  };
  let t = read();
  const apply = v => {
    document.documentElement.dataset.theme = v;
    const l = document.getElementById('theme-link'); if (l) l.textContent = v === 'dark' ? 'light mode' : 'dark mode';
  };
  apply(t);
  const mk = () => {
    const l = document.createElement('a'); l.id = 'theme-link'; l.href = '#';
    l.onclick = e => { e.preventDefault(); t = t === 'dark' ? 'light' : 'dark'; write(t); apply(t); };
    document.body.append(l); apply(t);
  };
  if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
  // carry the current choice (with the time it was made) on links to other pages, just before they are followed
  const carry = e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.id === 'theme-link' || !/\.html(\?|#|$)/.test(a.getAttribute('href'))) return;
    if (!stamp) { const p = parse(window.name) || parse(location.hash); stamp = p ? p.v + '.' + p.ts : t + '.0'; }
    a.href = a.href.split('#')[0] + '#igt-theme=' + stamp;
  };
  ['pointerdown', 'click', 'auxclick', 'keydown'].forEach(ev => document.addEventListener(ev, carry, true));
  // The browser's back button returns to the library page as it was left, with the old choice. So a machine page puts one
  // guard entry on top of its history: going back lands on it, and it sends you to the library carrying the current choice.
  if (!/index\.html$/.test(location.pathname)) {
    try { history.pushState({ igtGuard: 1 }, '', location.href); } catch (e) {}
    window.addEventListener('popstate', () => { location.replace('index.html#igt-theme=' + (stamp || t + '.' + Date.now())); });
  }
  // coming back to a page (back button, restored from the page cache) or another tab changing it: follow the newest choice
  const sync = () => { t = read(); apply(t); };
  window.addEventListener('pageshow', sync);
  window.addEventListener('storage', e => { if (e.key === KEY) sync(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
})();
// ---- style debug panel: fonts, title bar and colour themes (the "style" link, or Ctrl+Shift+D) ----
// Choices are stored per browser (localStorage 'igt-style') and apply to every page. Colour themes come in two kinds:
// hand-made variable sets in theme.css (<html data-pl> for light mode, <html data-pd> for dark mode; Sky is the light default), and themes generated
// here from a hue and a saturation (presets, or "Custom" with sliders), written as CSS variables on <html>. The dark default, Royal blue, is one of those.
(function () {
  const KEY = 'igt-style';
  // [label, CSS family, Google Fonts name]. Google fonts need an internet connection; the rest ship with Windows.
  const FONTS = [
    ['Segoe UI (default)', '"Segoe UI"'], ['Istok Web', '"Istok Web"'], ['Segoe UI Variable', '"Segoe UI Variable Text", "Segoe UI"'],
    ['Tahoma', 'Tahoma'], ['Verdana', 'Verdana'], ['Trebuchet MS', '"Trebuchet MS"'], ['Calibri', 'Calibri'], ['Corbel', 'Corbel'],
    ['Candara', 'Candara'], ['Bahnschrift', 'Bahnschrift'], ['Franklin Gothic', '"Franklin Gothic Medium"'], ['Lucida Sans', '"Lucida Sans Unicode"'],
    ['Arial', 'Arial'], ['Georgia', 'Georgia'], ['Cambria', 'Cambria'], ['Palatino', '"Palatino Linotype"'], ['Consolas', 'Consolas'],
    ['Inter (web)', 'Inter', 'Inter:wght@400;700'], ['Nunito (web)', 'Nunito', 'Nunito:wght@400;700'],
    ['Open Sans (web)', '"Open Sans"', 'Open+Sans:wght@400;700'], ['Ubuntu (web)', 'Ubuntu', 'Ubuntu:wght@400;700'],
    ['Exo 2 (web)', '"Exo 2"', 'Exo+2:wght@400;700'], ['Quicksand (web)', 'Quicksand', 'Quicksand:wght@400;700'],
    ['Rubik (web)', 'Rubik', 'Rubik:wght@400;700'], ['IBM Plex Sans (web)', '"IBM Plex Sans"', 'IBM+Plex+Sans:wght@400;700'],
    ['Space Grotesk (web)', '"Space Grotesk"', 'Space+Grotesk:wght@400;700'], ['Josefin Sans (web)', '"Josefin Sans"', 'Josefin+Sans:wght@400;700'],
    ['Orbitron (web)', 'Orbitron', 'Orbitron:wght@400;700'], ['Press Start 2P (web)', '"Press Start 2P"', 'Press+Start+2P'],
  ];
  const BARS = [['hidden', 'No bar (default)'], ['smoke', 'Smoky glass'], ['frost', 'Frosted white glass'], ['aqua', 'Aqua gel'],
    ['clear', 'Clear, text on the sky'], ['slim', 'Slim dark strip'], ['band', 'Light band (like section heads)'], ['float', 'Floating glass card'],
    ['glow', 'Fade with glowing line']];
  // [id, label, hue, saturation]; entries without a hue are the hand-made sets in theme.css
  const LIGHT = [['sky', 'Sky (default)'], ['ocean', 'Deep ocean'], ['mint', 'Mint'], ['sunset', 'Sunset'], ['lavender', 'Lavender'], ['silver', 'Silver'],
    ['rose', 'Rose', 340, 65], ['coral', 'Coral', 8, 75], ['peach', 'Peach', 25, 85], ['honey', 'Honey', 42, 85], ['lemon', 'Lemon', 52, 80],
    ['lime', 'Lime', 90, 55], ['meadow', 'Meadow', 120, 40], ['teal', 'Teal', 172, 60], ['aqua', 'Aqua', 188, 75], ['cornflower', 'Cornflower', 218, 65],
    ['periwinkle', 'Periwinkle', 232, 50], ['orchid', 'Orchid', 290, 42], ['blush', 'Blush', 320, 45], ['sand', 'Sand', 36, 35],
    ['stone', 'Stone', 30, 8], ['cloud', 'Cloud', 210, 12], ['custom', 'Custom…']];
  const DARK = [['blue', 'Royal blue (default)', 240, 100], ['dusk', 'Dusk'], ['midnight', 'Midnight'], ['ocean', 'Ocean'], ['forest', 'Forest'], ['ember', 'Ember'], ['graphite', 'Graphite'],
    ['plum', 'Plum', 285, 40], ['wine', 'Wine', 345, 50], ['crimson', 'Crimson', 355, 65], ['amber', 'Amber', 32, 65], ['olive', 'Olive', 70, 30],
    ['pine', 'Pine', 150, 40], ['teal', 'Teal', 180, 50], ['navy', 'Navy', 225, 55], ['cobalt', 'Cobalt', 215, 80], ['violet', 'Violet', 265, 50],
    ['aubergine', 'Aubergine', 300, 28], ['slate', 'Slate', 215, 18], ['mocha', 'Mocha', 25, 25], ['coal', 'Coal', 0, 0], ['custom', 'Custom…']];
  const GEN = ['--sky', '--glow', '--streak', '--ink', '--dim', '--faint', '--rule', '--link', '--link-hover', '--pane', '--pane-edge', '--pane-line',
    '--band', '--band-text', '--band-line', '--btn', '--btn-line', '--btn-hover', '--btn-hover-line', '--side-shadow'];
  const c = (h, s, l, a) => 'hsl(' + h + ' ' + Math.round(s) + '% ' + l + '%' + (a != null ? ' / ' + a : '') + ')';
  const grad = (h, s, l) => 'linear-gradient(180deg, ' + c(h, s, l[0]) + ' 0%, ' + c(h, s, l[1]) + ' 49%, ' + c(h, s, l[2]) + ' 50%, ' + c(h, s, l[3]) + ' 100%)';
  const m = Math.min;
  const lightVars = (h, S) => ({
    '--sky': 'linear-gradient(180deg, ' + c(h, S, 40) + ' 0%, ' + c(h, S, 56) + ' 28%, ' + c(h, S * .85, 78) + ' 60%, ' + c(h, S * .7, 95) + ' 100%)',
    '--ink': c(h, m(S, 45), 15), '--dim': c(h, m(S, 28), 32), '--faint': c(h, m(S, 16), 50), '--rule': c(h, m(S, 50), 40, .28),
    '--link': S < 12 ? c(210, 60, 32) : c(h, m(80, S + 10), 30), '--link-hover': c((h + 150) % 360, 65, 32),
    '--pane-line': c(h, m(S, 50), 35, .35),
    '--band': grad(h, m(S, 70), [97, 90, 84, 91]), '--band-text': c(h, m(S, 60), 22), '--band-line': c(h, m(S, 45), 70),
    '--btn-hover': grad(h, m(S, 80), [98, 91, 80, 87]), '--btn-hover-line': c(h, m(S, 55), 48),
    '--side-shadow': '0 1px 3px ' + c(h, m(S, 80), 12, .6) });
  const darkVars = (h, S) => ({
    '--sky': 'linear-gradient(180deg, ' + c(h, S, 4) + ' 0%, ' + c(h, S, 10) + ' 40%, ' + c(h, S * .9, 17) + ' 75%, ' + c(h, S * .8, 24) + ' 100%)',
    '--glow': c(h, S ? 90 : 0, 70, .14), '--streak': c(h, S ? 80 : 0, 85, .03),
    '--pane': c(h, S * .6, 8, .7), '--pane-edge': c(h, m(S, 80), 85, .2), '--pane-line': c(h, m(S, 50), 70, .3), '--rule': c(h, m(S, 60), 85, .2),
    '--dim': c(h, m(S, 25), 80), '--faint': c(h, m(S, 15), 60),
    '--link': S < 12 ? c(210, 80, 80) : c(h, 90, 80), '--link-hover': c((h + 150) % 360, 85, 78),
    '--band': grad(h, S * .5, [34, 25, 18, 23]), '--band-line': c(h, S * .6, 6),
    '--btn': grad(h, S * .45, [38, 29, 21, 26]), '--btn-line': c(h, S * .6, 6),
    '--btn-hover': grad(h, S * .5, [50, 40, 32, 37]) });
  const read = () => { try { const v = JSON.parse(localStorage.getItem(KEY)) || {}; return typeof v.body === 'number' || typeof v.head === 'number' ? {} : v; } catch (e) { return {}; } };
  const write = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  let s = read();
  const font = label => FONTS.find(f => f[0] === label);
  const fam = f => f[1] + ', "Segoe UI", sans-serif';
  const load = f => {
    if (!f[2]) return; const id = 'gf-' + f[2].replace(/[^a-z0-9]/gi, '');
    if (document.getElementById(id)) return;
    const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=' + f[2] + '&display=swap'; document.head.append(l);
  };
  const hueOf = mode => [s[mode + 'Hue'] != null ? s[mode + 'Hue'] : (mode === 'dark' ? 240 : 200), s[mode + 'Sat'] != null ? s[mode + 'Sat'] : (mode === 'dark' ? 100 : 60)];
  const apply = () => {
    const r = document.documentElement, st = r.style, b = font(s.body), h = font(s.head);
    if (b && b !== FONTS[0]) { load(b); st.setProperty('--sans', fam(b)); } else st.removeProperty('--sans');
    if (h) { load(h); st.setProperty('--head', fam(h)); } else st.removeProperty('--head');
    if (document.body) document.body.style.fontSize = s.size && s.size !== 14 ? s.size + 'px' : '';
    // the title bar is hidden unless a style is picked
    if (s.bar && s.bar !== 'hidden') r.dataset.bar = s.bar; else delete r.dataset.bar;
    // colours: only the theme of the current mode is applied; switching mode re-runs this
    const dark = r.dataset.theme === 'dark', mode = dark ? 'dark' : 'light';
    const list = dark ? DARK : LIGHT, t = list.find(x => x[0] === s[mode]) || list[0];
    for (const k of GEN) st.removeProperty(k);
    delete r.dataset.pl; delete r.dataset.pd;
    if (t[0] === 'custom' || t[2] != null) {
      const [hh, ss] = t[0] === 'custom' ? hueOf(mode) : [t[2], t[3]];
      const v = (dark ? darkVars : lightVars)(hh, ss);
      for (const k in v) st.setProperty(k, v[k]);
    } else if (t !== list[0]) r.dataset[dark ? 'pd' : 'pl'] = t[0];
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const summary = () => {
    const out = ['body font: ' + (s.body || FONTS[0][0])];
    if (s.head) out.push('heading font: ' + s.head);
    if (s.size && s.size !== 14) out.push('text size: ' + s.size + 'px');
    out.push('title bar: ' + (s.bar || 'hidden'));
    for (const mode of ['light', 'dark']) {
      const t = s[mode] || (mode === 'light' ? 'sky' : 'blue');
      out.push(mode + ' theme: ' + t + (t === 'custom' ? ' (hue ' + hueOf(mode)[0] + ', saturation ' + hueOf(mode)[1] + '%)' : ''));
    }
    return out.join('\n');
  };
  const build = () => {
    apply();
    const p = document.createElement('div'); p.id = 'style-panel'; p.hidden = true;
    const esc = t => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const fonts = first => (first ? '<option value="">' + first + '</option>' : '') +
      FONTS.map(f => '<option value="' + esc(f[0]) + '" style="font-family:' + f[1].replace(/"/g, "'") + '">' + f[0] + '</option>').join('');
    const list = a => a.map(x => '<option value="' + x[0] + '">' + x[1] + '</option>').join('');
    const custom = mode => '<div class="custom" data-mode="' + mode + '"><span>Hue</span><input type="range" min="0" max="359" data-k="' + mode + 'Hue">' +
      '<span>Saturation</span><input type="range" min="0" max="100" data-k="' + mode + 'Sat"></div>';
    p.innerHTML = '<h4><span>Style debug</span><a title="Close">&#x2715;</a></h4>' +
      '<label>Body font</label><select data-k="body">' + fonts() + '</select>' +
      '<label>Heading font</label><select data-k="head">' + fonts('Same as body') + '</select>' +
      '<div class="sample"><b style="font-family:var(--head)">IGT Emulator Library</b><br>Jacks or Better - payback 99.54%</div>' +
      '<label>Text size: <span class="sz"></span></label><input type="range" min="12" max="17" step="1" data-k="size">' +
      '<label>Title bar</label><select data-k="bar">' + list(BARS) + '</select>' +
      '<label>Light mode colours</label><select data-k="light">' + list(LIGHT) + '</select>' + custom('light') +
      '<label>Dark mode colours</label><select data-k="dark">' + list(DARK) + '</select>' + custom('dark') +
      '<div class="row2"><button data-a="mode">Switch light / dark</button></div>' +
      '<div class="row2"><button data-a="reset">Reset</button><button data-a="copy">Copy settings</button></div><code></code>';
    document.body.append(p);
    const q = k => p.querySelector('[data-k="' + k + '"]');
    const show = () => {
      q('body').value = s.body || FONTS[0][0]; q('head').value = s.head || ''; q('size').value = s.size || 14;
      p.querySelector('.sz').textContent = (s.size || 14) + 'px'; q('bar').value = s.bar || 'hidden';
      q('light').value = s.light || 'sky'; q('dark').value = s.dark || 'blue';
      for (const mode of ['light', 'dark']) {
        p.querySelector('.custom[data-mode="' + mode + '"]').hidden = s[mode] !== 'custom';
        const [hh, ss] = hueOf(mode); q(mode + 'Hue').value = hh; q(mode + 'Sat').value = ss;
        // hue slider shows the colour wheel at the chosen saturation
        q(mode + 'Hue').style.background = 'linear-gradient(90deg' + [0, 60, 120, 180, 240, 300, 360].map(x => ', ' + c(x, ss, 50)).join('') + ')';
      }
      p.querySelector('code').textContent = summary();
    };
    p.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      const v = e.target.value;
      if (k === 'size' || /Hue$|Sat$/.test(k)) s[k] = +v; else if (v) s[k] = v; else delete s[k];
      // picking a theme for the mode that is not showing switches to that mode, so the choice is visible
      const dark = document.documentElement.dataset.theme === 'dark';
      if ((k.startsWith('light') && dark) || (k.startsWith('dark') && !dark)) { const l = document.getElementById('theme-link'); if (l) l.click(); }
      write(s); apply(); show();
    });
    p.querySelector('[data-a="mode"]').onclick = () => { const l = document.getElementById('theme-link'); if (l) l.click(); };
    p.querySelector('[data-a="reset"]').onclick = () => { s = {}; write(s); apply(); show(); };
    p.querySelector('[data-a="copy"]').onclick = () => { try { navigator.clipboard.writeText(summary()); } catch (e) {} };
    p.querySelector('h4 a').onclick = () => { p.hidden = true; };
    const link = document.createElement('a'); link.id = 'style-link'; link.href = '#'; link.textContent = 'style';
    const toggle = () => { p.hidden = !p.hidden; if (!p.hidden) show(); };
    link.onclick = e => { e.preventDefault(); toggle(); };
    // style button removed from the page; Ctrl+Shift+D still toggles the panel
    document.addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); toggle(); } });
    window.addEventListener('storage', e => { if (e.key === KEY) { s = read(); apply(); if (!p.hidden) show(); } });
    // machine pages: <h1 id="vm-title"> follows the page title, which each page sets to the machine's name
    const t = document.getElementById('vm-title');
    if (t) {
      const sync = () => { t.textContent = document.title.replace(/\s*\([^)]*\d%\)\s*$/, ''); };   // drop a folder suffix like "(pepk1015 99.20%)"
      sync(); new MutationObserver(sync).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
    }
  };
  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
// ---- black "loading" screen over the emulator canvas until the machine is ready ----
function screenLoading(canvas) {
  if (!document.getElementById('igt-load-css')) {
    const s = document.createElement('style'); s.id = 'igt-load-css';
    s.textContent = '.screenwrap{position:relative}.screenwrap .loading{position:absolute;inset:0;background:#000;color:#9a9a9a;display:flex;align-items:center;justify-content:center;font:14px var(--mono,monospace);letter-spacing:.12em;text-transform:uppercase;z-index:2}' +
      '.screenwrap .loading::after{content:"";display:inline-block;width:1.5em;text-align:left;animation:igt-dots 1.2s steps(4) infinite;overflow:hidden;white-space:nowrap}' +
      '.screenwrap .notice{position:absolute;left:50%;bottom:8%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:6px 14px;font:13px var(--sans,sans-serif);z-index:3;pointer-events:none;white-space:nowrap}' +
      '@keyframes igt-dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}';
    document.head.append(s);
  }
  const w = document.createElement('div'); w.className = 'screenwrap';
  canvas.parentNode.insertBefore(w, canvas); w.append(canvas);
  const l = document.createElement('div'); l.className = 'loading'; l.textContent = 'Loading'; w.append(l);
  let nt = 0, n = null;
  return { done() { l.remove(); },
    // short message over the bottom of the screen (e.g. "Coin returned")
    notice(text) { if (!n) { n = document.createElement('div'); n.className = 'notice'; w.append(n); } n.textContent = text; n.hidden = false; clearTimeout(nt); nt = setTimeout(() => { n.hidden = true; }, 2500); } };
}
// ---- pay tables (data in paytables.js, generated by tools/make_paytables.js) ----
function payMachine(key) {
  const P = window.PAYTABLES; if (!P) return null;
  return P.machines.find(m => new RegExp(m.match, 'i').test(key)) || null;
}
function paySummary(m) {
  if (!m) return '';
  if (m.summary) return m.summary;
  const r = (m.games || []).map(g => window.PAYTABLES.games[g].rtp).filter(x => x != null);
  if (!r.length) return '';
  const lo = Math.min(...r), hi = Math.max(...r);
  return 'payback ' + (lo === hi ? hi.toFixed(2) : lo.toFixed(2) + '–' + hi.toFixed(2)) + '%';
}
// fills el with the pay tables of machine m (object from payMachine); title = false leaves out the heading
function renderPayTable(el, m, heading) {
  el.textContent = '';
  if (!m) return;
  const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  // on the machine pages the whole table sits under a quiet, closed-by-default dropdown
  let out = el;
  if (heading !== false) { out = mk('details', null, 'quiet'); out.append(mk('summary', 'Pay table and payback')); el.append(out); }
  if (m.note) out.append(mk('p', m.note));
  if (m.text) out.append(mk('p', m.text));
  if (!m.games) return;
  out.append(mk('p', 'Pays are in coins, as shown on the machine itself. Payback is exact for perfect strategy at 5 coins, worked out by enumerating all 2,598,960 starting hands.'));
  const grid = mk('div', null, 'paygrid');
  for (const id of m.games) {
    const g = window.PAYTABLES.games[id], box = mk('div', null, 'paybox');
    box.append(mk('h3', g.name + (g.rtp != null ? ' - payback ' + g.rtp.toFixed(2) + '%' : '')));
    const t = mk('table', null, 'pay'), h = t.insertRow();
    for (const x of ['Hand', '1 coin', '5 coins']) h.append(mk('th', x));
    for (const [n, c1, c5] of g.rows) { const r = t.insertRow(); r.insertCell().textContent = n; r.insertCell().textContent = c1; r.insertCell().textContent = c5; }
    box.append(t); if (g.note) box.append(mk('small', g.note)); grid.append(box);
  }
  out.append(grid);
}
window.Common = { setVolume, getVolume: () => volume, screenLoading, kvGet, kvSet, startAudio, pushAudio, InfoPanel, ReceiptsPanel, hex, audio, library, romBytes, payMachine, paySummary, renderPayTable };
})();
