// node gk_run.js <set> <frames> <out.png> [nv.bin]  - boot a Game King set with the configured NV image
const fs = require('fs');
const { GameKing } = require('./gameking.js');
const { loadSet } = require('./gk_load.js');
const { savePNG } = require('./run.js');
const [id, frames, png, nvf] = process.argv.slice(2);
const m = new GameKing(loadSet(id));
require('./devices.js')(m);
const nv = nvf ? new Uint8Array(fs.readFileSync(nvf)) : null;
if (nvf !== 'blank') { // default: gkigt4's configured image
  const src = nv || new Uint8Array(Buffer.from(fs.readFileSync(__dirname + '/configured.nv')));
  m.setNV(src);
}
m.reset();
const t = Date.now();
for (let i = 0; i < +frames; i++) m.runFrame();
console.log(id, 'frames', m.frame, 'IP', m.cpu.IP.toString(16), (Date.now() - t) / 1000 + 's');
if (m.diag) console.log(m.diag.slice(-600));
savePNG(png, 640, 480, m.render(new Uint32Array(640 * 480)));
if (process.env.NVOUT) fs.writeFileSync(process.env.NVOUT, Buffer.from(m.getNV()));
