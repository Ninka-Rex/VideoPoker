// Packs every ROM (and the shipped set-up NV images) into plain <script> files so the pages work straight from
// disk (file://), no server needed:  node build_bundle.js
//   bundle/library.js        window.LIBRARY = the same listing /api/library returns
//   bundle/data/<n>.js       window.ROMDATA[<path>] = base64 of one file (loaded on demand)
// Re-run it after adding ROMs or regenerating emu/nv/*.nv.
'use strict';
const fs = require('fs'), path = require('path');
const { scanPE, scanD80, scanGK, scanSetChip, root } = require('./serve.js');
const crypto = require('crypto');
const lib = { peplus: scanPE(), gameking: scanGK(), draw80: scanD80(), setchip: scanSetChip() };
// how each Player's Edge program has to be set up (found by tools/qualify.js)
const setups = fs.existsSync(path.join(__dirname, 'setups.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'setups.json'), 'utf8')) : {};
for (const s of lib.peplus) { const q = setups[path.basename(s.dir)]; if (q) { s.mode = q.mode; if (q.setchip) s.setchip = true; s.game = q.game; s.short = q.short; s.payback = q.payback; s.section = q.section; } }
for (const s of lib.draw80) { const q = setups[path.basename(s.dir)]; if (q) { s.game = q.game; s.short = q.short; s.section = q.section; s.year = q.year; } }
// screenshots made by make_previews.js
const { slug } = require('./make_previews.js');
const prev = k => fs.existsSync(path.join(__dirname, 'previews', slug(k) + '.png')) ? 'previews/' + slug(k) + '.png' : null;
for (const s of lib.peplus) s.preview = prev(s.dir + '/' + s.prog);
for (const s of lib.draw80) s.preview = prev(s.dir);
for (const s of lib.gameking) s.preview = prev(s.id);
const paths = new Set();
for (const s of lib.peplus) s.files.forEach(f => paths.add(f));
for (const s of lib.draw80) s.files.forEach(f => paths.add(f));
if (lib.setchip) lib.setchip.files.forEach(f => paths.add(f));
for (const s of lib.gameking) { Object.values(s.files).forEach(f => paths.add(f)); if (s.nv) paths.add(s.nv); }
const out = path.join(__dirname, 'bundle');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'data'), { recursive: true });
const index = {}; let n = 0, bytes = 0;
// identical files (shared graphics ROMs) are stored once
const byHash = new Map();
for (const p of [...paths].sort()) {
  const data = fs.readFileSync(path.join(root, p)), h = crypto.createHash('sha1').update(data).digest('hex');
  if (!byHash.has(h)) byHash.set(h, { data, names: [] });
  byHash.get(h).names.push(p); bytes += data.length;
}
for (const { data, names } of byHash.values()) {
  const name = 'data/' + (n++) + '.js', b64 = data.toString('base64');
  fs.writeFileSync(path.join(out, name), 'window.ROMDATA=window.ROMDATA||{};var d="' + b64 + '";' + names.map(p => 'window.ROMDATA[' + JSON.stringify(p) + ']=d;').join(''));
  for (const p of names) index[p] = name;
}
lib.files = index;
fs.writeFileSync(path.join(out, 'library.js'), 'window.LIBRARY=' + JSON.stringify(lib) + ';');
console.log(paths.size + ' files (' + byHash.size + ' distinct), ' + (bytes / 1048576).toFixed(1) + ' MB before sharing, packed into emu/bundle');
