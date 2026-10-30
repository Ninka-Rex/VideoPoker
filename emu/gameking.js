// IGT Game King (038/039 board) machine emulation.
// Memory map and video from MAME src/mame/igt/gkigt.cpp; I/O devices are being
// reverse engineered from the firmware.
'use strict';

const I960Impl = (typeof require !== 'undefined') ? require('./i960.js').I960 : window.I960;

const MB = 1 << 20;

class Region {
  constructor(size, readOnly) {
    this.u8 = new Uint8Array(size);
    this.u16 = new Uint16Array(this.u8.buffer);
    this.u32 = new Uint32Array(this.u8.buffer);
    this.mask = size - 1;
    this.readOnly = readOnly;
  }
}

class GameKing {
  constructor(roms) {
    // roms: { base, gme1, gme2, plx1, plx2, cg1, cg2, snd1, snd2 } as Uint8Array
    this.base = new Region(512 * 1024, true);
    this.base.u8.set(roms.base);
    this.game = new Region(4 * MB, true);         // 0x08000000: gme (2MB) + pxl (2MB)
    interleave(this.game.u8, 0, roms.gme1, roms.gme2);
    interleave(this.game.u8, 2 * MB, roms.plx1, roms.plx2);
    this.cg = new Uint8Array(roms.cg1.length * 2);
    interleave(this.cg, 0, roms.cg1, roms.cg2);
    this.snd = new Region(2 * MB, true);
    this.snd.u8.set(roms.snd1, 0); this.snd.u8.set(roms.snd2, roms.snd1.length);
    this.ram = new Region(16 * MB, false);        // 0x10000000: NVRAM (first 128K) + work RAM
    // Battery-backed CMOS: 512KB at 0x10000000-0x1007ffff. The firmware keeps meters,
    // terminal data, game data and progressives there (MAME only maps 128KB).
    this.NV_SIZE = (roms && roms.nvSize) || 0x80000;
    this.roms = { billValidator: !!(roms && roms.billValidator), printer: !!(roms && roms.printer), sas: !!(roms && roms.sas) };
    this.ram.u8.fill(0xff, 0, this.NV_SIZE);
    this.vram = new Region(2 * MB, false);        // 0x18000000
    this.iac = new Region(128 * 1024, false);     // 0xa1000000
    this.palette = new Uint32Array(256);          // 0xAABBGGRR for canvas ImageData
    this.palRGB = new Uint8Array(768);
    this.palIndex = 0; this.palSub = 0; this.palMask = 0xff;

    this.ioLog = new Map();
    this.log = [];
    this.inputs = { in1: 0xffffffff, in2: 0xffffffff };

    this.cpu = new I960Impl(this);
    this.frame = 0;
    this.line = 0;
    this.LINES = 525;
    this.cyclesPerLine = 24000000 / 60 / 525;   // ~762
    this.devices = [];
  }

  addDevice(dev) { this.devices.push(dev); return dev; }

  reset() {
    for (const d of this.devices) if (d.reset) d.reset();
    this.cpu.reset();
  }

  // ---------------- bus ----------------
  isBurst(a) { return (a >>> 24) !== 0x28 && (a & 0xfff00000) !== 0x18200000 >>> 0; }

  region(a) {
    switch (a >>> 24) {
      case 0x00: return a < 0x80000 ? this.base : null;
      case 0x08: return a < 0x08400000 ? this.game : null;
      case 0x10: return this.ram;
      case 0x18: return a < 0x18200000 ? this.vram : null;
      case 0x3b: return a < 0x3b200000 ? this.snd : null;
      case 0xa1: return this.iac;
    }
    return null;
  }

  r8(a) {
    const g = this.region(a);
    if (g) return g.u8[a & g.mask];
    return this.ioRead(a, 1);
  }
  r16(a) {
    const g = this.region(a);
    if (g) return g.u16[(a & g.mask) >>> 1];
    return this.ioRead(a, 2);
  }
  r32(a) {
    const g = this.region(a);
    if (g) return g.u32[(a & g.mask) >>> 2];
    return this.ioRead(a, 4);
  }
  w8(a, v) {
    const g = this.region(a);
    if (g) { if (!g.readOnly) g.u8[a & g.mask] = v; return; }
    this.ioWrite(a, v, 1);
  }
  w16(a, v) {
    const g = this.region(a);
    if (g) { if (!g.readOnly) g.u16[(a & g.mask) >>> 1] = v; return; }
    this.ioWrite(a, v, 2);
  }
  w32(a, v) {
    const g = this.region(a);
    if (g) { if (!g.readOnly) g.u32[(a & g.mask) >>> 2] = v; return; }
    this.ioWrite(a, v, 4);
  }

  // I/O devices sit on byte lanes 0 and 2 of each 32-bit word (umask 0x00ff00ff).
  ioRead(a, size) {
    if (size === 1) return this.ioRead8(a) & 0xff;
    if (size === 2) return (this.ioRead8(a) & 0xff) | ((this.ioRead8(a + 1) & 0xff) << 8);
    return ((this.ioRead8(a) & 0xff) | ((this.ioRead8(a + 1) & 0xff) << 8) |
            ((this.ioRead8(a + 2) & 0xff) << 16) | ((this.ioRead8(a + 3) & 0xff) << 24)) >>> 0;
  }
  ioWrite(a, v, size) {
    if (size === 1) return this.ioWrite8(a, v & 0xff);
    for (let i = 0; i < size; i++) this.ioWrite8(a + i, (v >>> (8 * i)) & 0xff);
  }

  note(kind, a, v) {
    const k = kind + ' ' + (a >>> 0).toString(16);
    const e = this.ioLog.get(k);
    if (e) { e.n++; e.last = v; } else this.ioLog.set(k, { n: 1, last: v, pc: this.cpu.PIP });
  }

  ioRead8(a) {
    a >>>= 0;
    for (const d of this.devices) {
      if (d.read && a >= d.start && a <= d.end) return d.read(a);
    }
    if (a >= 0x18200000 && a < 0x18200004) {
      // raster position: the firmware reads (value >> 3) as the current line
      // (all readers at 0x080584e0-0x08058bdc); MAME's vpos-as-is makes waits hang.
      if (a === 0x18200000) return (this.line << 3) & 0xff;
      if (a === 0x18200001) return ((this.line << 3) >> 8) & 0xff;
      if (a === 0x18200002) return 0x38;
      return 0;
    }
    this.note('R', a, 0);
    return 0xff;
  }

  ioWrite8(a, v) {
    a >>>= 0;
    for (const d of this.devices) {
      if (d.write && a >= d.start && a <= d.end) return d.write(a, v);
    }
    // RAMDAC (ADV476): index, palette data (R,G,B 6-bit), mask
    if (a === 0x28060000) { this.palIndex = v; this.palSub = 0; return; }
    if (a === 0x28060002) {
      this.palRGB[this.palIndex * 3 + this.palSub] = (v & 0x3f) << 2 | (v & 0x3f) >> 4;
      if (++this.palSub === 3) {
        const i = this.palIndex, r = this.palRGB[i * 3], g = this.palRGB[i * 3 + 1], b = this.palRGB[i * 3 + 2];
        this.palette[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
        this.palSub = 0; this.palIndex = (this.palIndex + 1) & 0xff;
      }
      return;
    }
    if (a === 0x28060004) { this.palMask = v; return; }
    if (a >= 0x28060000 && a < 0x28070000) return;
    if (a >= 0x28030000 && a < 0x28030004) return;   // watchdog
    this.note('W', a, v);
  }

  // ---------------- timing ----------------
  runFrame() {
    for (this.line = 0; this.line < this.LINES; this.line++) {
      for (const d of this.devices) if (d.tick) d.tick(this.cyclesPerLine);
      this.cpu.run(this.cyclesPerLine);
    }
    this.frame++;
  }

  // ---------------- video ----------------
  // Returns 640x480 RGBA pixels (Uint32 0xAABBGGRR).
  render(out) {
    const pal = this.palette;
    const vr = this.vram.u8;
    // background tilemap: 256x128 tiles of 4x4, 4bpp from CG ROM, entries at 0x18100000
    const bg = this.vram.u32, bgBase = 0x100000 >>> 2;
    const cg = this.cg;
    for (let ty = 0; ty < 120; ty++) {
      for (let tx = 0; tx < 160; tx++) {
        const e = bg[bgBase + ty * 256 + tx];
        // tile index: bits 0-11, plus bank bits 16-20 as index bits 12-16 (bit 20
        // selects the upper half of the CG ROM; Black Rhino uses it, MAME ignores it)
        const tile = (e & 0x0fff) | ((e >>> 4) & 0x1f000);
        const color = (e >>> 24) & 0xf;
        const t = (tile * 8) % cg.length;
        for (let y = 0; y < 4; y++) {
          const b0 = cg[t + y * 2], b1 = cg[t + y * 2 + 1];
          // MAME layout: x offsets {4,0,12,8} in a 16-bit row
          const px = [b0 & 15, (b0 >> 4) & 15, b1 & 15, (b1 >> 4) & 15];
          const o = (ty * 4 + y) * 640 + tx * 4;
          for (let x = 0; x < 4; x++) out[o + x] = pal[color * 16 + px[x]];
        }
      }
    }
    // bitmap layer: 8bpp, 1024 bytes per line, colour 0 transparent
    for (let y = 0; y < 480; y++) {
      const src = y * 1024, dst = y * 640;
      for (let x = 0; x < 640; x++) {
        const c = vr[src + x];
        if (c) out[dst + x] = pal[c];
      }
    }
    return out;
  }
}

function interleave(dst, off, even, odd) {
  for (let i = 0; i < even.length; i++) { dst[off + i * 2] = even[i]; dst[off + i * 2 + 1] = odd[i]; }
}

if (typeof module !== 'undefined') module.exports = { GameKing };
else window.GameKing = GameKing;

// ---------------- non-volatile memory (CMOS + EEPROM) ----------------
GameKing.prototype.getNV = function () {
  const nv = new Uint8Array(this.NV_SIZE + 0x800);
  nv.set(this.ram.u8.subarray(0, this.NV_SIZE), 0);
  if (this.senet) nv.set(this.senet.eeprom, this.NV_SIZE);
  return nv;
};
GameKing.prototype.setNV = function (nv) {
  this.ram.u8.set(nv.subarray(0, this.NV_SIZE), 0);
  if (this.senet) this.senet.eeprom.set(nv.subarray(this.NV_SIZE, this.NV_SIZE + 0x800));
};

// ---------------- save states ----------------
// Generic snapshot of plain data fields (numbers, strings, booleans, arrays,
// typed arrays) on the machine and its devices. Object references (bus, cpu,
// machine back-pointers) and functions are skipped.
function plainArray(a) {
  return a.every(x => x === null || typeof x !== 'object' || (Array.isArray(x) && plainArray(x)));
}
function snapObj(o) {
  const s = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null || typeof v === 'function') continue;
    if (ArrayBuffer.isView(v)) s[k] = v.slice();
    else if (Array.isArray(v)) { if (plainArray(v)) s[k] = JSON.parse(JSON.stringify(v)); }
    else if (typeof v !== 'object') s[k] = v;
    else if (Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(x => x === null || typeof x !== 'object'))
      s[k] = { ...v };                                  // small plain records, e.g. door switches
  }
  return s;
}
function restoreObj(o, s) {
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (ArrayBuffer.isView(v) && ArrayBuffer.isView(o[k]) && o[k].length === v.length) o[k].set(v);
    else if (Array.isArray(v)) o[k] = JSON.parse(JSON.stringify(v));
    else if (v && typeof v === 'object' && o[k] && typeof o[k] === 'object') Object.assign(o[k], v);
    else o[k] = v;
  }
}
GameKing.prototype.stateObjects = function () {
  const list = { m: this, cpu: this.cpu, ram: this.ram, vram: this.vram, iac: this.iac };
  for (const k of ['quart1', 'quart2', 'senet', 'ds2401', 'bus', 'touch']) if (this[k]) list[k] = this[k];
  return list;
};
GameKing.prototype.saveState = function () {
  const st = {};
  for (const [k, o] of Object.entries(this.stateObjects())) st[k] = snapObj(o);
  return st;
};
GameKing.prototype.loadState = function (st) {
  for (const [k, o] of Object.entries(this.stateObjects())) if (st[k]) restoreObj(o, st[k]);
};
