// Intel MCS-51 family core (8051 / 8052 / 80C32): full instruction set, timers 0-2,
// serial port, two external interrupts, 256 bytes of internal RAM.
// Cycle counts are machine cycles (12 clocks); run(n) executes until n cycles have elapsed.
'use strict';
(function () {

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let p = 0; for (let b = 0; b < 8; b++) p ^= (i >> b) & 1; PARITY[i] = p; }

class MCS51 {
  // bus: { code: Uint8Array(65536), xread(addr), xwrite(addr, v), portOut(n, v), portIn(n) -> byte|undefined, serialTx(v) }
  constructor(bus) {
    this.bus = bus;
    this.code = bus.code;
    this.iram = new Uint8Array(256);
    this.sfr = new Uint8Array(256);
    this.reset();
  }
  reset() {
    this.iram.fill(0); this.sfr.fill(0);
    this.pc = 0; this.cycles = 0;
    const s = this.sfr;
    s[0x81] = 7; s[0x80] = s[0x90] = s[0xa0] = s[0xb0] = 0xff;
    this.acc = 0; this.b = 0; this.psw = 0;
    this.inService = [false, false];
    this.intLine = [false, false];
    this.serialBusy = 0; this.serialRxQ = []; this.sbufIn = 0;
  }

  get dptr() { return this.sfr[0x82] | (this.sfr[0x83] << 8); }
  set dptr(v) { this.sfr[0x82] = v & 0xff; this.sfr[0x83] = (v >> 8) & 0xff; }
  get cy() { return (this.psw >> 7) & 1; }

  readPort(n, latch) {
    const l = this.sfr[0x80 + n * 0x10];
    if (latch) return l;
    const ext = this.bus.portIn ? this.bus.portIn(n) : undefined;
    return ext === undefined ? l : (l & ext);
  }
  rdDirect(a, latch) {
    if (a < 0x80) return this.iram[a];
    switch (a) {
      case 0xe0: return this.acc;
      case 0xf0: return this.b;
      case 0xd0: return (this.psw & 0xfe) | PARITY[this.acc];
      case 0x80: case 0x90: case 0xa0: case 0xb0: return this.readPort((a - 0x80) >> 4, latch);
      case 0x99: return this.sbufIn;
      default: return this.sfr[a];
    }
  }
  wrDirect(a, v) {
    v &= 0xff;
    if (a < 0x80) { this.iram[a] = v; return; }
    switch (a) {
      case 0xe0: this.acc = v; return;
      case 0xf0: this.b = v; return;
      case 0xd0: this.psw = v; return;
      case 0x80: case 0x90: case 0xa0: case 0xb0:
        this.sfr[a] = v;
        if (this.bus.portOut) this.bus.portOut((a - 0x80) >> 4, v);
        return;
      case 0x99: this.serialBusy = 1200; if (this.bus.serialTx) this.bus.serialTx(v); return;
      default: this.sfr[a] = v;
    }
  }
  rdBit(b) {
    if (b < 0x80) return (this.iram[0x20 + (b >> 3)] >> (b & 7)) & 1;
    return (this.rdDirect(b & 0xf8, true) >> (b & 7)) & 1;
  }
  wrBit(b, v) {
    if (b < 0x80) {
      const a = 0x20 + (b >> 3), m = 1 << (b & 7);
      this.iram[a] = v ? this.iram[a] | m : this.iram[a] & ~m; return;
    }
    const a = b & 0xf8, m = 1 << (b & 7), cur = this.rdDirect(a, true);
    this.wrDirect(a, v ? cur | m : cur & ~m);
  }
  push(v) { const sp = (this.sfr[0x81] + 1) & 0xff; this.sfr[0x81] = sp; this.iram[sp] = v & 0xff; }
  pop() { const sp = this.sfr[0x81]; this.sfr[0x81] = (sp - 1) & 0xff; return this.iram[sp]; }

  add(v, c) {
    const a = this.acc, r = a + v + c;
    let psw = this.psw & 0x3b;
    if (r > 0xff) psw |= 0x80;
    if (((a & 15) + (v & 15) + c) > 15) psw |= 0x40;
    if ((((a & 0x7f) + (v & 0x7f) + c) >> 7) !== (r > 0xff ? 1 : 0)) psw |= 0x04;
    this.psw = psw; this.acc = r & 0xff;
  }
  subb(v, c) {
    const a = this.acc, r = a - v - c;
    let psw = this.psw & 0x3b;
    if (r < 0) psw |= 0x80;
    if (((a & 15) - (v & 15) - c) < 0) psw |= 0x40;
    if ((((a & 0x7f) - (v & 0x7f) - c) < 0 ? 1 : 0) !== (r < 0 ? 1 : 0)) psw |= 0x04;
    this.psw = psw; this.acc = r & 0xff;
  }

  // external interrupt pin n (0/1); asserted = active (low on the real pin)
  setInt(n, asserted) {
    const it = (this.sfr[0x88] >> (n * 2)) & 1;
    if (it && asserted && !this.intLine[n]) this.sfr[0x88] |= (2 << (n * 2));
    this.intLine[n] = asserted;
  }

  timers(cy) {
    const s = this.sfr, tmod = s[0x89];
    let tcon = s[0x88];
    for (let t = 0; t < 2; t++) {
      if (!((tcon >> (t ? 6 : 4)) & 1)) continue;
      const mode = (tmod >> (t * 4)) & 3;
      if ((tmod >> (t * 4 + 2)) & 1) continue;      // counter mode: no external clock modelled
      const tl = t ? 0x8b : 0x8a, th = t ? 0x8d : 0x8c, tf = t ? 0x80 : 0x20;
      if (mode === 0) {
        let v = ((s[th] << 5) | (s[tl] & 0x1f)) + cy;
        if (v > 0x1fff) { tcon |= tf; v &= 0x1fff; }
        s[tl] = v & 0x1f; s[th] = (v >> 5) & 0xff;
      } else if (mode === 1) {
        let v = ((s[th] << 8) | s[tl]) + cy;
        if (v > 0xffff) { tcon |= tf; v &= 0xffff; }
        s[tl] = v & 0xff; s[th] = v >> 8;
      } else if (mode === 2) {
        let v = s[tl] + cy;
        while (v > 0xff) { tcon |= tf; v = v - 256 + s[th]; }
        s[tl] = v;
      } else if (t === 0) {
        let v = s[0x8a] + cy;
        if (v > 0xff) { tcon |= 0x20; v &= 0xff; }
        s[0x8a] = v;
        if (tcon & 0x40) { let w = s[0x8c] + cy; if (w > 0xff) { tcon |= 0x80; w &= 0xff; } s[0x8c] = w; }
      }
    }
    s[0x88] = tcon;
    const t2 = s[0xc8];
    if (t2 & 0x04) {
      let v = ((s[0xcd] << 8) | s[0xcc]) + cy;
      if (v > 0xffff) {
        if (!(t2 & 0x30)) s[0xc8] |= 0x80;
        v = (t2 & 1) ? (v & 0xffff) : ((s[0xcb] << 8) | s[0xca]);
      }
      s[0xcc] = v & 0xff; s[0xcd] = v >> 8;
    }
    if (this.serialBusy > 0) { this.serialBusy -= cy; if (this.serialBusy <= 0) { this.serialBusy = 0; s[0x98] |= 0x02; } }
    if (this.serialRxQ.length && !(s[0x98] & 1) && (s[0x98] & 0x10)) { this.sbufIn = this.serialRxQ.shift(); s[0x98] |= 1; }
  }

  checkInterrupts() {
    const s = this.sfr, ie = s[0xa8];
    if (!(ie & 0x80)) return 0;
    const tcon = s[0x88];
    const ie0 = (tcon & 1) ? (tcon & 2) !== 0 : this.intLine[0];
    const ie1 = (tcon & 4) ? (tcon & 8) !== 0 : this.intLine[1];
    const pend = [(ie & 1) && ie0, (ie & 2) && (tcon & 0x20), (ie & 4) && ie1, (ie & 8) && (tcon & 0x80),
                  (ie & 16) && (s[0x98] & 3), (ie & 32) && (s[0xc8] & 0xc0)];
    const ip = s[0xb8];
    for (let level = 1; level >= 0; level--) {
      if (this.inService[1]) break;
      if (level === 0 && this.inService[0]) break;
      for (let i = 0; i < 6; i++) {
        if (!pend[i] || ((ip >> i) & 1) !== level) continue;
        if (i === 0 && (tcon & 1)) s[0x88] &= ~0x02;
        if (i === 1) s[0x88] &= ~0x20;
        if (i === 2 && (tcon & 4)) s[0x88] &= ~0x08;
        if (i === 3) s[0x88] &= ~0x80;
        this.push(this.pc & 0xff); this.push(this.pc >> 8);
        this.pc = 3 + i * 8;
        this.inService[level] = true;
        return 2;
      }
    }
    return 0;
  }

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) {
      let c = this.checkInterrupts();
      if (!c) c = this.step();
      this.cycles += c;
      this.timers(c);
    }
  }

  fetch() { const v = this.code[this.pc]; this.pc = (this.pc + 1) & 0xffff; return v; }
  rel8() { const r = this.fetch(); return r & 0x80 ? r - 256 : r; }
  reg(n) { return (this.psw & 0x18) + n; }
  jr(r) { this.pc = (this.pc + r) & 0xffff; }
  src(op) {
    const k = op & 15;
    if (k === 4) return this.fetch();
    if (k === 5) return this.rdDirect(this.fetch());
    if (k < 8) return this.iram[this.iram[this.reg(k & 1)]];
    return this.iram[this.reg(k & 7)];
  }
  cjne(a, b, r) { this.psw = (this.psw & 0x7f) | (a < b ? 0x80 : 0); if (a !== b) this.jr(r); }

  step() {
    const op = this.fetch();
    let t;
    switch (op & 0xf8) {
      case 0x08: t = this.reg(op & 7); this.iram[t] = (this.iram[t] + 1) & 0xff; return 1;
      case 0x18: t = this.reg(op & 7); this.iram[t] = (this.iram[t] - 1) & 0xff; return 1;
      case 0x28: this.add(this.iram[this.reg(op & 7)], 0); return 1;
      case 0x38: this.add(this.iram[this.reg(op & 7)], this.cy); return 1;
      case 0x48: this.acc |= this.iram[this.reg(op & 7)]; return 1;
      case 0x58: this.acc &= this.iram[this.reg(op & 7)]; return 1;
      case 0x68: this.acc ^= this.iram[this.reg(op & 7)]; return 1;
      case 0x78: this.iram[this.reg(op & 7)] = this.fetch(); return 1;
      case 0x88: t = this.fetch(); this.wrDirect(t, this.iram[this.reg(op & 7)]); return 2;
      case 0x98: this.subb(this.iram[this.reg(op & 7)], this.cy); return 1;
      case 0xa8: t = this.fetch(); this.iram[this.reg(op & 7)] = this.rdDirect(t); return 2;
      case 0xb8: { const imm = this.fetch(), r = this.rel8(); this.cjne(this.iram[this.reg(op & 7)], imm, r); return 2; }
      case 0xc8: { t = this.reg(op & 7); const v = this.iram[t]; this.iram[t] = this.acc; this.acc = v; return 1; }
      case 0xd8: { const r = this.rel8(); t = this.reg(op & 7); this.iram[t] = (this.iram[t] - 1) & 0xff; if (this.iram[t]) this.jr(r); return 2; }
      case 0xe8: this.acc = this.iram[this.reg(op & 7)]; return 1;
      case 0xf8: this.iram[this.reg(op & 7)] = this.acc; return 1;
    }
    switch (op) {
      case 0x00: return 1;
      case 0x02: { const h = this.fetch(), l = this.fetch(); this.pc = (h << 8) | l; return 2; }
      case 0x03: this.acc = ((this.acc >> 1) | (this.acc << 7)) & 0xff; return 1;
      case 0x04: this.acc = this.acc + 1; return 1;
      case 0x05: t = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) + 1); return 1;
      case 0x06: case 0x07: t = this.iram[this.reg(op & 1)]; this.iram[t] = (this.iram[t] + 1) & 0xff; return 1;
      case 0x10: { const b = this.fetch(), r = this.rel8(); if (this.rdBit(b)) { this.wrBit(b, 0); this.jr(r); } return 2; }
      case 0x12: { const h = this.fetch(), l = this.fetch(); this.push(this.pc & 0xff); this.push(this.pc >> 8); this.pc = (h << 8) | l; return 2; }
      case 0x13: { const c = this.cy; this.psw = (this.psw & 0x7f) | ((this.acc & 1) << 7); this.acc = (this.acc >> 1) | (c << 7); return 1; }
      case 0x14: this.acc = this.acc - 1; return 1;
      case 0x15: t = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) - 1); return 1;
      case 0x16: case 0x17: t = this.iram[this.reg(op & 1)]; this.iram[t] = (this.iram[t] - 1) & 0xff; return 1;
      case 0x20: { const b = this.fetch(), r = this.rel8(); if (this.rdBit(b)) this.jr(r); return 2; }
      case 0x22: { const h = this.pop(), l = this.pop(); this.pc = (h << 8) | l; return 2; }
      case 0x23: this.acc = ((this.acc << 1) | (this.acc >> 7)) & 0xff; return 1;
      case 0x24: this.add(this.fetch(), 0); return 1;
      case 0x25: case 0x26: case 0x27: this.add(this.src(op), 0); return 1;
      case 0x30: { const b = this.fetch(), r = this.rel8(); if (!this.rdBit(b)) this.jr(r); return 2; }
      case 0x32: { const h = this.pop(), l = this.pop(); this.pc = (h << 8) | l;
        if (this.inService[1]) this.inService[1] = false; else this.inService[0] = false; return 2; }
      case 0x33: { const c = this.cy; this.psw = (this.psw & 0x7f) | (this.acc & 0x80); this.acc = ((this.acc << 1) | c) & 0xff; return 1; }
      case 0x34: this.add(this.fetch(), this.cy); return 1;
      case 0x35: case 0x36: case 0x37: this.add(this.src(op), this.cy); return 1;
      case 0x40: { const r = this.rel8(); if (this.cy) this.jr(r); return 2; }
      case 0x42: t = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) | this.acc); return 1;
      case 0x43: { t = this.fetch(); const v = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) | v); return 2; }
      case 0x44: this.acc |= this.fetch(); return 1;
      case 0x45: case 0x46: case 0x47: this.acc |= this.src(op); return 1;
      case 0x50: { const r = this.rel8(); if (!this.cy) this.jr(r); return 2; }
      case 0x52: t = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) & this.acc); return 1;
      case 0x53: { t = this.fetch(); const v = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) & v); return 2; }
      case 0x54: this.acc &= this.fetch(); return 1;
      case 0x55: case 0x56: case 0x57: this.acc &= this.src(op); return 1;
      case 0x60: { const r = this.rel8(); if (!this.acc) this.jr(r); return 2; }
      case 0x62: t = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) ^ this.acc); return 1;
      case 0x63: { t = this.fetch(); const v = this.fetch(); this.wrDirect(t, this.rdDirect(t, true) ^ v); return 2; }
      case 0x64: this.acc ^= this.fetch(); return 1;
      case 0x65: case 0x66: case 0x67: this.acc ^= this.src(op); return 1;
      case 0x70: { const r = this.rel8(); if (this.acc) this.jr(r); return 2; }
      case 0x72: { const b = this.fetch(); if (this.rdBit(b)) this.psw |= 0x80; return 2; }
      case 0x73: this.pc = (this.dptr + this.acc) & 0xffff; return 2;
      case 0x74: this.acc = this.fetch(); return 1;
      case 0x75: { t = this.fetch(); const v = this.fetch(); this.wrDirect(t, v); return 2; }
      case 0x76: case 0x77: this.iram[this.iram[this.reg(op & 1)]] = this.fetch(); return 1;
      case 0x80: { const r = this.rel8(); this.jr(r); return 2; }
      case 0x82: { const b = this.fetch(); if (!this.rdBit(b)) this.psw &= 0x7f; return 2; }
      case 0x83: this.acc = this.code[(this.pc + this.acc) & 0xffff]; return 2;
      case 0x84: if (this.b === 0) this.psw = (this.psw & 0x7b) | 0x04;
        else { const q = (this.acc / this.b) | 0, r = this.acc % this.b; this.acc = q; this.b = r; this.psw &= 0x7b; } return 4;
      case 0x85: { const s = this.fetch(), d = this.fetch(); this.wrDirect(d, this.rdDirect(s)); return 2; }
      case 0x86: case 0x87: t = this.fetch(); this.wrDirect(t, this.iram[this.iram[this.reg(op & 1)]]); return 2;
      case 0x90: { const h = this.fetch(), l = this.fetch(); this.dptr = (h << 8) | l; return 2; }
      case 0x92: { const b = this.fetch(); this.wrBit(b, this.cy); return 2; }
      case 0x93: this.acc = this.code[(this.dptr + this.acc) & 0xffff]; return 2;
      case 0x94: this.subb(this.fetch(), this.cy); return 1;
      case 0x95: case 0x96: case 0x97: this.subb(this.src(op), this.cy); return 1;
      case 0xa0: { const b = this.fetch(); if (!this.rdBit(b)) this.psw |= 0x80; return 2; }
      case 0xa2: { const b = this.fetch(); this.psw = (this.psw & 0x7f) | (this.rdBit(b) << 7); return 1; }
      case 0xa3: this.dptr = (this.dptr + 1) & 0xffff; return 2;
      case 0xa4: { const p = this.acc * this.b; this.acc = p & 0xff; this.b = p >> 8; this.psw = (this.psw & 0x7b) | (p > 0xff ? 0x04 : 0); return 4; }
      case 0xa5: return 1;
      case 0xa6: case 0xa7: t = this.fetch(); this.iram[this.iram[this.reg(op & 1)]] = this.rdDirect(t); return 2;
      case 0xb0: { const b = this.fetch(); if (this.rdBit(b)) this.psw &= 0x7f; return 2; }   // ANL C,/bit
      case 0xb2: { const b = this.fetch(); this.wrBit(b, this.rdBit(b) ^ 1); return 1; }
      case 0xb3: this.psw ^= 0x80; return 1;
      case 0xb4: { const imm = this.fetch(), r = this.rel8(); this.cjne(this.acc, imm, r); return 2; }
      case 0xb5: { const v = this.rdDirect(this.fetch()), r = this.rel8(); this.cjne(this.acc, v, r); return 2; }
      case 0xb6: case 0xb7: { const imm = this.fetch(), r = this.rel8(); this.cjne(this.iram[this.iram[this.reg(op & 1)]], imm, r); return 2; }
      case 0xc0: t = this.fetch(); this.push(this.rdDirect(t)); return 2;
      case 0xc2: { const b = this.fetch(); this.wrBit(b, 0); return 1; }
      case 0xc3: this.psw &= 0x7f; return 1;
      case 0xc4: this.acc = ((this.acc << 4) | (this.acc >> 4)) & 0xff; return 1;
      case 0xc5: { t = this.fetch(); const v = this.rdDirect(t, true); this.wrDirect(t, this.acc); this.acc = v; return 1; }
      case 0xc6: case 0xc7: { t = this.iram[this.reg(op & 1)]; const v = this.iram[t]; this.iram[t] = this.acc; this.acc = v; return 1; }
      case 0xd0: t = this.fetch(); this.wrDirect(t, this.pop()); return 2;
      case 0xd2: { const b = this.fetch(); this.wrBit(b, 1); return 1; }
      case 0xd3: this.psw |= 0x80; return 1;
      case 0xd4: { let a = this.acc, psw = this.psw;
        if ((a & 15) > 9 || (psw & 0x40)) { a += 6; if (a > 0xff) psw |= 0x80; }
        if (((a >> 4) > 9) || (psw & 0x80)) { a += 0x60; if (a > 0xff) psw |= 0x80; }
        this.acc = a & 0xff; this.psw = psw; return 1; }
      case 0xd5: { t = this.fetch(); const r = this.rel8(); const v = (this.rdDirect(t, true) - 1) & 0xff; this.wrDirect(t, v); if (v) this.jr(r); return 2; }
      case 0xd6: case 0xd7: { t = this.iram[this.reg(op & 1)]; const v = this.iram[t]; this.iram[t] = (v & 0xf0) | (this.acc & 0x0f); this.acc = (this.acc & 0xf0) | (v & 0x0f); return 1; }
      case 0xe0: this.acc = this.bus.xread(this.dptr) & 0xff; return 2;
      case 0xe2: case 0xe3: this.acc = this.bus.xread(this.iram[this.reg(op & 1)] | (this.sfr[0xa0] << 8)) & 0xff; return 2;
      case 0xe4: this.acc = 0; return 1;
      case 0xe5: this.acc = this.rdDirect(this.fetch()); return 1;
      case 0xe6: case 0xe7: this.acc = this.iram[this.iram[this.reg(op & 1)]]; return 1;
      case 0xf0: this.bus.xwrite(this.dptr, this.acc); return 2;
      case 0xf2: case 0xf3: this.bus.xwrite(this.iram[this.reg(op & 1)] | (this.sfr[0xa0] << 8), this.acc); return 2;
      case 0xf4: this.acc ^= 0xff; return 1;
      case 0xf5: this.wrDirect(this.fetch(), this.acc); return 1;
      case 0xf6: case 0xf7: this.iram[this.iram[this.reg(op & 1)]] = this.acc; return 1;
    }
    if ((op & 0x1f) === 0x01) { const l = this.fetch(); this.pc = (this.pc & 0xf800) | ((op >> 5) << 8) | l; return 2; }
    if ((op & 0x1f) === 0x11) { const l = this.fetch(); this.push(this.pc & 0xff); this.push(this.pc >> 8); this.pc = (this.pc & 0xf800) | ((op >> 5) << 8) | l; return 2; }
    throw new Error('bad opcode ' + op.toString(16) + ' at ' + ((this.pc - 1) & 0xffff).toString(16));
  }
}
// ACC, B, PSW wrap to 8 bits on assignment
for (const f of ['acc', 'b', 'psw']) {
  const k = '_' + f;
  Object.defineProperty(MCS51.prototype, f, { get() { return this[k] | 0; }, set(v) { this[k] = v & 0xff; } });
}

if (typeof module !== 'undefined') module.exports = { MCS51 }; else window.MCS51 = MCS51;
})();
