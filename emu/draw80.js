// IGT Draw 80 Poker (Sircoma/IGT, 1982): 8039 + 6845 CRTC + AY-3-8912, two 4 KB program banks.
// Port decoding, inputs and video follow MAME's drw80pkr.cpp.
'use strict';
(function () {
const MC = (typeof require !== 'undefined') ? require('./mcs48.js').MCS48 : window.MCS48;
const AY = (typeof require !== 'undefined') ? require('./ay8910.js').AY8910 : window.AY8910;

const CPU_HZ = 8000000 / 15;
const LINES = 257, FPS = 4000000 / 256 / 257;
const FRAME_CYCLES = CPU_HZ / FPS;

class Draw80 {
  // roms: { pm: [pm0, pm1], cg: [cg0, cg1], prom: Uint8Array(256) }
  constructor(roms) {
    this.roms = roms;
    this.rom = new Uint8Array(0x2000); this.rom.set(roms.pm[0], 0); this.rom.set(roms.pm[1], 0x1000);
    this.bank = 0;
    this.io = new Uint8Array(0x100);                 // battery-backed RAM behind port 0xfb
    this.dsw = 0x67;
    this.keysIn1 = 0; this.keysIn2 = 0;
    this.decode(); this.buildPalette();
    this.ay = new AY(20000000 / 12, 44100);
    this.ay.portA = () => this.dsw;
    this.cpu = new MC({
      rom: a => this.rom[this.bank * 0x1000 + (a & 0xfff)],
      xread: a => this.ioRead(a), xwrite: (a, v) => this.ioWrite(a, v),
      p1r: () => this.p1, p1w: v => { this.p1 = v; }, p2r: () => this.p2, p2w: v => { this.p2 = v; },
      busr: () => this.busv, busw: v => { this.busv = v; },
      prog: s => { if (s === 1) this.bank ^= 1; },
      t0: () => 0, t1: () => 1,
    });
    this.reset();
  }
  reset() {
    this.cpu.reset(); this.bank = 0;
    this.p1 = 0xff; this.p2 = 0xff; this.busv = 0xff;
    this.vram = new Uint16Array(0x400); this.cram = new Uint8Array(0x400);
    this.crtcAddr = 0; this.crtc = new Uint8Array(32);
    this.frame = 0; this.line = 0; this.hopperOn = false; this.hopperT = 0; this.hopperLine = 0;
    this.attract = 0; this.out = { counters: 0, lamps: 0 };
  }
  decode() {
    const [c0, c1] = this.roms.cg;
    this.tiles = new Uint8Array(512 * 64);
    for (let t = 0; t < 512; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const s = 7 - x;
      this.tiles[t * 64 + y * 8 + x] = (((c0[t * 8 + y] >> s) & 1) << 1) | ((c1[t * 8 + y] >> s) & 1);
    }
  }
  buildPalette() {
    const p = this.roms.prom; this.palette = new Uint32Array(256);
    for (let j = 0; j < 256; j++) {
      const d = p[j % p.length], i = (d >> 3) & 1;
      const t = b => 0xf0 - 0xf0 * ((d >> b) & 1);
      const r = t(0) - i * ((t(0) / 5) | 0), g = t(1) - i * ((t(1) / 5) | 0), b = t(2) - i * ((t(2) / 5) | 0);
      this.palette[j] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
  render(px) {
    for (let row = 0; row < 27; row++) for (let col = 0; col < 24; col++) {
      const i = row * 24 + col, code = this.vram[i] & 0x1ff, color = this.cram[i] & 15;
      for (let y = 0; y < 8; y++) {
        const o = (row * 8 + y) * 192 + col * 8;
        for (let x = 0; x < 8; x++) px[o + x] = this.palette[color * 4 + this.tiles[code * 64 + y * 8 + x]];
      }
    }
  }

  ioWrite(off, v) {
    const p1 = this.p1, p2 = this.p2;
    switch (p2) {
      case 0x3f: this.vram[(((p1 & 0xc0) << 2) + off) & 0x3ff] = v; break;
      case 0x7f: { const n = (((p1 & 0xc0) << 2) + off) & 0x3ff; this.cram[n] = v & 15; this.vram[n] = (this.vram[n] + ((v & 0xf0) << 4)) & 0xffff; break; }
      case 0xc7: this.crtcAddr = v & 0x1f; break;
      case 0xd7: this.crtc[this.crtcAddr] = v; break;
      case 0xfb: this.io[off] = v; break;
      case 0xff:
        switch (p1) {
          case 0xf7: this.out.counters = v & 15; this.hopperOn = ((v >> 4) & 1) && ((v >> 5) & 1); if (this.onOutput) this.onOutput('meters', v); break;
          case 0xef: this.out.lamps = v; if (this.onOutput) this.onOutput('lamps', v); break;
          case 0xdf: this.attract = v; break;
          case 0xfc: this.ay.writeAddr(v); break;
          case 0xfe: this.ay.writeData(v); break;
        }
    }
  }
  ioRead(off) {
    const p1 = this.p1, p2 = this.p2;
    switch (p2) {
      case 0x7b: case 0xfb: return this.io[off];
      case 0xff:
        switch (p1) {
          case 0xfe: return this.ay.readData();
          case 0xef: {
            switch (this.keysIn1) {
              case 0x00: return 0xc0; case 0x01: return 0xc4; case 0x02: return 0xc6;
              case 0x04: return 0xc8; case 0x08: return 0xd0; case 0x10: return 0xe0;
              case 0x20: return 0x80; case 0x40: return 0x40;
            }
            return 0;
          }
          case 0xf7: {
            if (this.hopperLine) return 0xc0;
            const T = [0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87];
            const k = this.keysIn2 & 0x7f;
            // keyboard encoder: low 3 bits are the key number, 0 = hold 5 and 7 = no key (found by watching hold 5
            // toggle by itself on every key release while "no key" read as 0)
            if (!k) return 0x87;
            for (let b = 0; b < 7; b++) if (k === (1 << b)) return b === 6 ? T[0] : T[b + 1];
            return 0x87;
          }
        }
    }
    return 0;
  }

  // keys: hold1..hold5, deal, bet; coin buttons: coin (key-in x1), coinB, coinC, keyout
  press(name, down) {
    const in2 = { hold4: 0x01, hold3: 0x02, hold2: 0x04, hold1: 0x08, deal: 0x10, bet: 0x20, hold5: 0x40 };
    const in1 = { keyout: 0x01, coin: 0x02, coinB: 0x20, coinC: 0x40 };
    if (in2[name]) this.keysIn2 = down ? (this.keysIn2 | in2[name]) : (this.keysIn2 & ~in2[name]);
    else if (in1[name]) this.keysIn1 = down ? in1[name] : 0;
  }
  insertCoin() { this.press('coin', true); this.coinUntil = this.frame + 6; this.coinsIn = (this.coinsIn || 0) + 1; }

  runFrame() {
    const base = this.cpu.cycles;
    const R = this.crtc;
    const ch = (R[9] || 7) + 1, total = ((R[4] || 32) + 1) * ch + R[5];
    for (let ln = 0; ln < LINES; ln++) {
      this.line = ln;
      // vsync position/width from the CRTC registers, scaled to our 257-line frame
      const scale = LINES / total;
      const vs = Math.round((R[7] || 28) * ch * scale), w = Math.max(1, Math.round(((R[3] >> 4) || 16) * scale));
      if (ln === vs) this.cpu.setIrq(true); else if (ln === (vs + w) % LINES) this.cpu.setIrq(false);
      // hopper: one coin pulse every 150 ms while the motor runs
      if (this.hopperOn) { this.hopperT += 1 / (FPS * LINES); { const hl = (this.hopperT % 0.15) < 0.075 ? 1 : 0; if (hl && !this.hopperLine) this.coinsOut = (this.coinsOut || 0) + 1; this.hopperLine = hl; } } else { this.hopperT = 0; this.hopperLine = 0; }
      const target = base + (ln + 1) * FRAME_CYCLES / LINES;
      const n = target - this.cpu.cycles;
      if (n > 0) this.cpu.run(n);
    }
    this.frame++;
    if (this.coinUntil && this.frame >= this.coinUntil) { this.press('coin', false); this.coinUntil = 0; }
    if (this.onAudio) { const n = 735, L = new Float32Array(n), Rr = new Float32Array(n); this.ay.render(L, Rr, 0, n); this.onAudio(L, Rr); }
  }
  getNV() { return this.io.slice(); }
  setNV(b) { if (b && b.length === 0x100) this.io.set(b); }
  info() {
    const c = this.cpu, h = (v, n) => v.toString(16).toUpperCase().padStart(n || 2, '0');
    return [['System'],
      ['architecture', 'Intel 8039 (MCS-48 family, 8-bit) · 8 MHz crystal, 0.53 million machine cycles/s'],
      ['program', '4 KB + 4 KB external ROM (pm0, pm1) · 128 bytes on-chip RAM'],
      ['video', 'MC6845-style CRTC, character graphics (cg0, cg1), colour PROM'],
      ['dip switches', 'SW1 = ' + h(this.dsw)],
      ['running', (c.cycles / CPU_HZ).toFixed(0) + ' s emulated'],
      ['Sound'], ['sound chip', this.ay.info()],
      ['Coins'], ['coin / key in', (this.coinsIn || 0) + ' inserted · ' + (this.coinsOut || 0) + ' paid out'], ['hopper', this.hopperOn ? 'running' : 'idle']];
  }
}
if (typeof module !== 'undefined') module.exports = { Draw80 }; else window.Draw80 = Draw80;
})();
