// Renders one attract-screen screenshot per library entry into previews/ (shown when hovering a link on the
// library page).  node make_previews.js [filter]   then   node build_bundle.js
'use strict';
const fs = require('fs'), path = require('path');
const { scanPE, scanD80, scanGK, root } = require('./serve.js');
const { savePNG } = require('./run.js');
const out = path.join(__dirname, 'previews'); fs.mkdirSync(out, { recursive: true });
const filter = process.argv[2] || '';
const slug = k => k.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
module.exports = { slug };
if (require.main !== module) return;
const todo = [];
const rd = f => new Uint8Array(fs.readFileSync(path.join(root, f)));

// screenshots taken by tools/qualify.js (it knows each program's set-up mode) are reused
const qshot = dir => path.join(__dirname, '..', 'scratch', 'boot', path.basename(dir).replace(/[^\w.()%-]/g, '_') + '.png');
for (const s of scanPE()) todo.push([slug(s.dir + '/' + s.prog), () => {
  if (fs.existsSync(qshot(s.dir))) { fs.copyFileSync(qshot(s.dir), path.join(out, slug(s.dir + '/' + s.prog) + '.png')); return; }
  const { PEPlus } = require('./peplus.js'), { buildPEPlusRoms } = require('./peroms.js');
  const m = new PEPlus(buildPEPlusRoms(s.files.map(f => ({ name: path.basename(f), data: rd(f) }))));
  m.startAutoSetup(); while (m.setupBusy) m.runFrame();
  const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
  run(1500); for (let i = 0; i < 4; i++) { m.insertCoin(); run(40); } run(200);
  const p = new Uint32Array(64000); m.render(p); savePNG(path.join(out, slug(s.dir + '/' + s.prog) + '.png'), 320, 200, p);
}]);
for (const s of scanD80()) todo.push([slug(s.dir), () => {
  const { Draw80 } = require('./draw80.js');
  const f = re => s.files.find(x => re.test(path.basename(x)));
  const m = new Draw80({ pm: [rd(f(/^pm0\./i)), rd(f(/^pm1\./i))], cg: [rd(f(/^cg0/i)), rd(f(/^cg1/i))], prom: rd(f(/^cap/i)) });
  const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
  run(600); m.insertCoin(); run(60);
  const p = new Uint32Array(192 * 216); m.render(p); savePNG(path.join(out, slug(s.dir) + '.png'), 192, 216, p);
}]);
for (const s of scanGK()) todo.push([slug(s.id), () => {
  const { GameKing } = require('./gameking.js'), { loadSet } = require('./gk_load.js');
  const m = new GameKing(loadSet(s.id)); require('./devices.js')(m);
  const nv = path.join(__dirname, 'nv', s.id + '.nv');
  if (s.id === 'gkigt4') { global.window = {}; require('./configured-nv.js'); m.setNV(new Uint8Array(Buffer.from(window.CONFIGURED_NV, 'base64'))); }
  else if (fs.existsSync(nv)) m.setNV(new Uint8Array(fs.readFileSync(nv)));
  m.reset();
  const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
  run(1500); m.insertCoin(); run(200);
  const p = new Uint32Array(640 * 480); m.render(p); savePNG(path.join(out, slug(s.id) + '.png'), 640, 480, p);
}]);
for (const [name, fn] of todo) {
  if (filter && !name.includes(filter)) continue;
  try { fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); }
}
