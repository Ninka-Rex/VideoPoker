// Headless runner for development: node run.js <frames> [options]
//   --png out.png   save the final screen
//   --io            print I/O access summary
//   --pc            print hot instruction addresses
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GameKing } = require('./gameking.js');

const ROMDIR = path.join(__dirname, '..', 'ROMs', 'Game King');
const rd = f => new Uint8Array(fs.readFileSync(path.join(ROMDIR, f)));
const roms = {
  base: rd('m0000527 base,1-4002.bin'),
  gme1: rd('g0001777 gme1 1 of 2,2-80.bin'), gme2: rd('g0001777 gme2 2 of 2,2-80.bin'),
  plx1: rd('c0000330 plx1 3 of 4,2-80.bin'), plx2: rd('c0000330 plx2 4 of 4,2-80.bin'),
  cg1: rd('c0000330 cg1 1 of 4,2-40.bin'), cg2: rd('c0000330 cg2 2 of 4,2-40.bin'),
  snd1: rd('swc00046 snd1 1 of 2,2-80.rom1'), snd2: rd('swc00046 snd2 2 of 2,2-80.rom2'),
};

function savePNG(file, w, h, rgba32) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const src = Buffer.from(rgba32.buffer, rgba32.byteOffset, w * h * 4);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; src.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function main() {
  const args = process.argv.slice(2);
  const frames = parseInt(args[0] || '60', 10);
  const opt = n => args.includes(n);
  const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

  const m = new GameKing(roms);
  const extra = val('--devices');
  if (extra) require(path.resolve(extra))(m);
  else { try { require('./devices.js')(m); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } }
  const loadnv = val('--loadnv');
  if (loadnv) {
    const b = new Uint8Array(fs.readFileSync(loadnv));
    m.ram.u8.set(b.subarray(0, 0x20000), 0); m.senet.eeprom.set(b.subarray(0x20000, 0x20800));
  }
  m.reset();

  const hot = new Map();
  let lastErr = null;
  m.cpu.onUnhandled = (ip, op, what) => { lastErr = `unhandled ${what} op=${(op >>> 0).toString(16)} at ${ip.toString(16)}`; m.cpu.halted = true; };
  const t0 = Date.now();
  let instr = 0;
  const script = val('--script') ? JSON.parse(val('--script')) : [];
  for (let f = 0; f < frames && !m.cpu.halted; f++) {
    for (const [sf, name, on] of script) if (sf === f) { m.setSwitch(name, on); console.log(`frame ${f}: ${name}=${on}`); }
    if (opt('--pc')) {
      for (let l = 0; l < m.LINES; l++) {
        m.line = l;
        for (const d of m.devices) if (d.tick) d.tick(m.cyclesPerLine);
        m.cpu.run(m.cyclesPerLine);
        hot.set(m.cpu.PIP, (hot.get(m.cpu.PIP) || 0) + 1);
      }
      m.frame++;
    } else m.runFrame();
  }
  const dt = (Date.now() - t0) / 1000;
  console.log(`frames=${m.frame} time=${dt.toFixed(2)}s IP=${m.cpu.IP.toString(16)} PC=${m.cpu.PC.toString(16)} ${lastErr || ''}`);
  if (opt('--io')) {
    const e = [...m.ioLog.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    for (const [k, v] of e) console.log(`  ${k.padEnd(12)} n=${v.n} last=${v.last} firstpc=${v.pc.toString(16)}`);
  }
  if (opt('--pc')) {
    const e = [...hot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log('hot:', e.map(([a, n]) => a.toString(16) + ':' + n).join(' '));
  }
  for (const l of m.log.slice(-40)) console.log('  log:', l);
  if (m.diag) console.log('--- diag serial ---\n' + m.diag.slice(-3000));
  const savenv = val('--savenv');
  if (savenv) {
    const b = new Uint8Array(0x20800); b.set(m.ram.u8.subarray(0, 0x20000), 0); b.set(m.senet.eeprom, 0x20000);
    fs.writeFileSync(savenv, b);
  }
  if (m.ds2401) console.log('1-wire commands seen:', m.ds2401.log.map(x => x.toString(16)).join(','));
  const png = val('--png');
  if (png) savePNG(png, 640, 480, m.render(new Uint32Array(640 * 480)));
  return m;
}

if (require.main === module) main();
module.exports = { roms, savePNG };
