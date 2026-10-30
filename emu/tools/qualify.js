// Boots one Player's Edge (Plus) set folder in every set-up mode and reports which one reaches a playable screen.
//   node qualify.js <set folder> <setchip folder> [out.png]   ->  one JSON line
'use strict';
const fs = require('fs'), path = require('path');
const E = path.join(__dirname, '..') + path.sep;
const { PEPlus } = require(E + 'peplus.js'), { buildPEPlusRoms } = require(E + 'peroms.js'), { makeSetChipNV } = require(E + 'pesetchip.js');
const { savePNG } = require(E + 'run.js');
const rd = d => buildPEPlusRoms(fs.readdirSync(d).map(f => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(d, f))) })));
const REF = new Uint32Array(new Uint8Array(fs.readFileSync(path.join(__dirname, 'setdenom_ref.bin'))).buffer.slice(0));

function classify(p, p0) {
  const cnt = new Map(); for (const v of p) cnt.set(v, (cnt.get(v) || 0) + 1);
  let dom = 0, n = 0; for (const [v, c] of cnt) if (c > n) { n = c; dom = v; }
  const frac = n / p.length;
  let same = 0, tot = 0;
  for (let y = 118; y < 138; y++) for (let x = 30; x < 290; x++) { tot++; if (p[y * 320 + x] === REF[(y - 118) * 260 + (x - 30)]) same++; }
  if (same / tot > 0.8) return 'setchip';
  const r = dom & 255, g = (dom >> 8) & 255, b = (dom >> 16) & 255;
  if (r + g + b > 650 && frac > 0.45) return 'cream';
  if (1 - frac < 0.02) return 'blank';
  if (p0) { let d = 0; for (let i = 0; i < p.length; i++) if (p[i] !== p0[i]) d++; if (d / p.length < 0.004) return 'dead'; }
  return 'ok';
}
function boot(roms, mode, nv, recover) {
  const m = new PEPlus(roms);
  if (nv) m.setNV(nv);
  if (recover) m.startRecover(); else if (!nv) m.startAutoSetup(mode);
  let n = 0; while (m.setupBusy && n++ < 20000) m.runFrame();
  const run = k => { for (let i = 0; i < k; i++) m.runFrame(); };
  run(1500); const p0 = new Uint32Array(64000); m.render(p0);
  for (let i = 0; i < 4; i++) { m.insertCoin(); run(40); } run(200);
  const p = new Uint32Array(64000); m.render(p); return { p, p0, m };
}
function qualify(dir, setDir) {
  const roms = rd(dir);
  if (!roms) return { error: 'no roms' };
  const modes = roms.superData ? ['hold', 'both', 'tap'] : ['tap', 'both', 'hold'];
  let last;
  for (const mode of modes) {
    const b = boot(roms, mode); const cls = classify(b.p, b.p0); last = { mode, cls, p: b.p }; if (process.env.DBG) console.error(mode, cls);
    if (cls === 'ok') return last;
    if ((cls === 'setchip' || cls === 'dead') && setDir) {
      const nv = makeSetChipNV(PEPlus, roms, rd(setDir), { mode });
      const b2 = boot(roms, mode, nv, true); const c2 = classify(b2.p, b2.p0);
      last = { mode, cls: c2, setchip: true, p: b2.p };
      if (process.env.DBG) console.error(mode, 'after setchip', c2); if (c2 === 'ok') return last;
    }
  }
  return last;
}
module.exports = { qualify, classify, boot, rd };
if (require.main === module) {
  const r = qualify(process.argv[2], process.argv[3]);
  if (process.argv[4] && r.p) savePNG(process.argv[4], 320, 200, r.p);
  console.log(JSON.stringify({ mode: r.mode, cls: r.cls, setchip: !!r.setchip, error: r.error }));
}
