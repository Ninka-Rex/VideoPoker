// Headless step tool working from save states:
//   node session.js <in.state|-> <out.state> <out.png> cmd...
//   cmds: run:N   tap:x,y   sw:name=0|1   btn:reg,bit=0|1
'use strict';
const fs = require('fs'); const v8 = require('v8');
const { savePNG } = require('./run.js'); const roms = process.env.GKSET ? require('./gk_load.js').loadSet(process.env.GKSET) : require('./run.js').roms;
const { GameKing } = require('./gameking.js');
const [inp, outp, png, ...cmds] = process.argv.slice(2);
const m = new GameKing(roms); require('./devices.js')(m);
if (inp === 'blank') { m.reset(); }
else if (inp === '-') {
  const b = new Uint8Array(fs.readFileSync('nv1.bin')); m.ram.u8.set(b.subarray(0, 0x20000)); m.senet.eeprom.set(b.subarray(0x20000));
  m.reset();
} else { m.reset(); m.loadState(v8.deserialize(fs.readFileSync(inp))); }
const mark = m.diag.length;
for (const c of cmds) {
  const [op, arg] = c.split(':');
  if (op === 'run') for (let f = 0; f < +arg; f++) m.runFrame();
  else if (op === 'tap') { const [x, y] = arg.split(',').map(Number); m.touch.touch(1, x, y); for (let f = 0; f < 8; f++) m.runFrame(); m.touch.touch(3, x, y); for (let f = 0; f < 60; f++) m.runFrame(); }
  else if (op === 'sw') { const [n, v] = arg.split('='); m.setSwitch(n, v === '1'); }
  else if (op === 'press') {   // down, stream of drag reports, lift
    const [x, y] = arg.split(',').map(Number);
    m.touch.touch(1, x, y); for (let i = 0; i < 6; i++) { for (let f = 0; f < 3; f++) m.runFrame(); m.touch.touch(2, x, y); }
    for (let f = 0; f < 4; f++) m.runFrame(); m.touch.touch(3, x, y); for (let f = 0; f < 60; f++) m.runFrame();
  }
  else if (op === 'coin') { for (let i = 0; i < (+arg || 1); i++) { m.insertCoin(); for (let f = 0; f < 15; f++) m.runFrame(); } }
  else if (op === 'poke') { const [a, v] = arg.split('='); m.cpu.wr8(parseInt(a, 16), parseInt(v, 16)); }
  else if (op === 'btn') { const [rb, v] = arg.split('='); const [r, bit] = rb.split(',').map(Number); if (v === '1') m.senet.inputs[r] |= 1 << bit; else m.senet.inputs[r] &= ~(1 << bit); }
}
fs.writeFileSync(outp, v8.serialize(m.saveState()));
if (png !== '-') savePNG(png, 640, 480, m.render(new Uint32Array(640 * 480)));
const d = m.diag.slice(mark).replace(/\r/g, ''); if (d.trim()) console.log(d.slice(-1500));
