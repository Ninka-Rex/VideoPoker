// node d80_run.js <rom folder> <frames> <out.png> [cmds: key:name | coin | run:N | shot:file | hold:name | release:name]
const fs = require('fs'), path = require('path');
const { Draw80 } = require('./draw80.js');
const { savePNG } = require('./run.js');
const [dir, frames, png, ...cmds] = process.argv.slice(2);
const rd = n => new Uint8Array(fs.readFileSync(path.join(dir, n)));
const roms = { pm: [rd('pm0.u81'), rd('pm1.u82')], cg: [rd('cg0-a.u74'), rd('cg1-a.u76')], prom: rd('cap13.u92') };
const m = new Draw80(roms);
if (process.env.NV && fs.existsSync(process.env.NV)) m.setNV(new Uint8Array(fs.readFileSync(process.env.NV)));
const run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
const shot = f => { const p = new Uint32Array(192 * 216); m.render(p); savePNG(f, 192, 216, p); };
try {
  run(+frames);
  for (const c of cmds) {
    const [k, v] = c.split(':');
    if (k === 'run') run(+v); else if (k === 'key') { m.press(v, true); run(8); m.press(v, false); run(8); }
    else if (k === 'hold') { m.press(v, true); run(30); } else if (k === 'release') { m.press(v, false); run(8); }
    else if (k === 'coin') { m.insertCoin(); run(20); } else if (k === 'shot') shot(v);
  }
} catch (e) { console.log('error', e.stack.split('\n').slice(0, 3).join(' | ')); }
console.log('frame', m.frame, 'pc', m.cpu.pc.toString(16), 'bank', m.bank, 'cycles', m.cpu.cycles);
shot(png);
if (process.env.NVOUT) fs.writeFileSync(process.env.NVOUT, Buffer.from(m.getNV()));
