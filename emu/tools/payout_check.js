// Plays hands on one Player's Edge set until a win is paid out through the hopper, then reports whether the game is still
// playable afterwards (a "HOPPER EMPTY" / coin-out tilt leaves it ignoring coins).
//   node payout_check.js <set folder> <setups key> [setchip folder]
'use strict';
const fs = require('fs'), path = require('path');
const E = path.join(__dirname, '..') + path.sep;
const { PEPlus } = require(E + 'peplus.js'), { makeSetChipNV } = require(E + 'pesetchip.js');
const { rd, classify } = require('./qualify.js');
const dir = process.argv[2], setDir = process.argv[4];
const setups = JSON.parse(fs.readFileSync(E + 'setups.json'));
const q = setups[path.basename(dir)] || {};
const roms = rd(dir);
const base = new PEPlus(roms);
let nv;
if (q.setchip && setDir) nv = makeSetChipNV(PEPlus, roms, rd(setDir), { mode: q.mode });
let first = true;
function fresh() {
  const m = new PEPlus(roms);
  if (nv) { m.setNV(nv); m.startRecover(); } else m.startAutoSetup(q.mode);
  let n = 0; while (m.setupBusy && n++ < 20000) m.runFrame();
  return m;
}
const g0 = fresh(); for (let i = 0; i < 1500; i++) g0.runFrame(); const saved = g0.getNV();
for (let a = 0; a < 70; a++) {
  const m = new PEPlus(roms); m.setNV(saved);
  const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
  const k = (nm, h = 10, w = 60) => { m.press(nm, true); run(h); m.press(nm, false); run(w); };
  run(300 + a * 13);
  for (let i = 0; i < 5; i++) { m.insertCoin(); run(40); }
  run(100); k('deal', 10, 250); k('deal', 10, 10);
  let maxState = 0; for (let t = 0; t < 40; t++) { run(30); maxState = Math.max(maxState, m.coinOutState); }
  if (!(m.coinsOut > 0)) continue;
  run(900);
  const p0 = new Uint32Array(64000); m.render(p0);
  for (let i = 0; i < 3; i++) { m.insertCoin(); run(40); } run(200);
  const p1 = new Uint32Array(64000); m.render(p1);
  const cls = classify(p1, p0);
  console.log(JSON.stringify({ won: true, attempt: a, coinsOut: m.coinsOut, after: cls }));
  process.exit(0);
}
console.log(JSON.stringify({ won: false }));
