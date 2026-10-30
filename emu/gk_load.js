// Node helper: load a Game King set by id from the ROM folder tree.
const fs = require('fs'), path = require('path');
const { SETS, patterns, nvSize, peripherals } = require('./gkroms.js');
function walk(d, out) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
function loadSet(id, root) {
  root = root || path.join(__dirname, '..');
  const all = walk(path.join(root, 'ROMs', 'Game King'), []);
  const pat = patterns(id), roms = {};
  for (const [k, re] of Object.entries(pat)) {
    const f = all.find(p => re.test(path.basename(p)));
    if (!f) { if (k.startsWith('snd')) continue; throw new Error(id + ': missing ' + k); }
    roms[k] = new Uint8Array(fs.readFileSync(f));
  }
  roms.nvSize = nvSize(id);
  Object.assign(roms, peripherals(id));
  return roms;
}
module.exports = { loadSet, SETS };
