// node pe_run.js <rom folder> <frames> <out.png> [cmds: key:name | coin | door:1 | run:N ...]
const fs = require('fs'), path = require('path');
const { PEPlus } = require('./peplus.js');
const { buildPEPlusRoms } = require('./peroms.js');
const { savePNG } = require('./run.js');
const [dir, frames, png, ...cmds] = process.argv.slice(2);
const files = dir.split('|').flatMap(d => fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile()).map(f => ({ name: f, data: new Uint8Array(fs.readFileSync(path.join(d, f))) })));
const roms = buildPEPlusRoms(files);
if (!roms) { console.log('rom set not recognised'); process.exit(1); }
const m = new PEPlus(roms); if (process.env.AUTO) { m.startAutoSetup(); }
if (process.env.NV && fs.existsSync(process.env.NV)) m.setNV(new Uint8Array(fs.readFileSync(process.env.NV)));
const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
try {
  run(+frames);
  for (const c of cmds) {
    const [k, v] = c.split(':');
    if (k === 'run') run(+v);
    else if (k === 'key') { m.press(v, true); run(8); m.press(v, false); run(8); }
    else if (k === 'hold') { m.press(v, true); run(60); }
    else if (k === 'release') { m.press(v, false); run(8); }
    else if (k === 'coin') { m.insertCoin(); run(30); }
    else if (k === 'shot') { const p = new Uint32Array(320*200); m.render(p); savePNG(v, 320, 200, p); }
    else if (k === 'door') { m.setDoor(v === '1'); run(10); }
  }
} catch (e) { console.log('CPU error', e.message, 'pc=', m.cpu.pc.toString(16)); }
console.log('frame', m.frame, 'pc', m.cpu.pc.toString(16), 'cycles', m.cpu.cycles);
const px = new Uint32Array(320 * 200); m.render(px);
savePNG(png, 320, 200, px);
if (process.env.NVOUT) fs.writeFileSync(process.env.NVOUT, Buffer.from(m.getNV()));
