// Intel 80960KA/KB CPU core.
// Behaviour follows MAME's i960 core (src/devices/cpu/i960/i960.cpp) and the
// 80960KB Programmer's Reference Manual. Floating point is not implemented
// (Game King firmware does not use it).
//
// Differences from MAME:
//  - Local registers are written to the frame on every call and read back on
//    every ret (no register cache). Equivalent for software that uses flushreg
//    before touching saved frames, and simpler to reason about.

'use strict';

const PFP = 0, SP = 1, RIP = 2, G14 = 30, FP = 31;

function sext(v, bits) { const s = 32 - bits; return (v << s) >> s; }

class I960 {
  constructor(bus) {
    this.bus = bus;
    this.r = new Uint32Array(32);
    this.SAT = 0; this.PRCB = 0; this.PC = 0; this.AC = 0;
    this.IP = 0; this.PIP = 0; this.ICR = 0;
    this.immIrq = 0; this.immVector = 0; this.immPri = 0;
    this.irqLine = [0, 0, 0, 0];
    this.icount = 0;
    this.ninstr = 0;              // instructions executed (used as a time base)
    this.halted = false;
    this.trace = null;            // optional function(ip, opcode)
    this.onUnhandled = null;      // optional function(ip, opcode, what)
  }

  // ---- memory helpers (handle unaligned accesses like MAME) ----
  rd8(a) { return this.bus.r8(a >>> 0); }
  rd16(a) { a >>>= 0; return (a & 1) ? (this.bus.r8(a) | (this.bus.r8(a + 1) << 8)) : this.bus.r16(a); }
  rd32(a) {
    a >>>= 0;
    if (a & 3) return (this.bus.r8(a) | (this.bus.r8(a + 1) << 8) | (this.bus.r8(a + 2) << 16) | (this.bus.r8(a + 3) << 24)) >>> 0;
    return this.bus.r32(a) >>> 0;
  }
  wr8(a, v) { this.bus.w8(a >>> 0, v & 0xff); }
  wr16(a, v) { a >>>= 0; if (a & 1) { this.bus.w8(a, v & 0xff); this.bus.w8(a + 1, (v >>> 8) & 0xff); } else this.bus.w16(a, v & 0xffff); }
  wr32(a, v) {
    a >>>= 0; v >>>= 0;
    if (a & 3) { this.bus.w8(a, v & 0xff); this.bus.w8(a + 1, (v >>> 8) & 0xff); this.bus.w8(a + 2, (v >>> 16) & 0xff); this.bus.w8(a + 3, v >>> 24); }
    else this.bus.w32(a, v);
  }

  reset() {
    this.SAT = this.rd32(0);
    this.PRCB = this.rd32(4);
    this.IP = this.rd32(12);
    this.PC = 0x001f2002;
    this.AC = 0;
    this.ICR = 0xff000000;
    this.immIrq = 0;
    this.r.fill(0);
    this.r[FP] = this.rd32(this.PRCB + 24);
    this.r[SP] = (this.r[FP] + 64) >>> 0;
    this.halted = false;
  }

  // ---- operand helpers ----
  src1(op) { return (op & 0x800) ? (op & 0x1f) : this.r[op & 0x1f]; }
  src2(op) { return (op & 0x1000) ? ((op >>> 14) & 0x1f) : this.r[(op >>> 14) & 0x1f]; }
  setDst(op, v) { this.r[(op >>> 19) & 0x1f] = v; }
  csrc1(op) { return (op & 0x2000) ? ((op >>> 19) & 0x1f) : this.r[(op >>> 19) & 0x1f]; }
  csrc2(op) { return this.r[(op >>> 14) & 0x1f]; }

  cmpU(a, b) { this.AC = (this.AC & ~7) | ((a >>> 0) < (b >>> 0) ? 4 : (a >>> 0) === (b >>> 0) ? 2 : 1); }
  cmpS(a, b) { this.AC = (this.AC & ~7) | ((a | 0) < (b | 0) ? 4 : (a | 0) === (b | 0) ? 2 : 1); }

  ea(op) {
    const abase = (op >>> 14) & 0x1f;
    if (!(op & 0x1000)) {             // MEMA
      const off = op & 0xfff;
      return (op & 0x2000) ? (this.r[abase] + off) >>> 0 : off;
    }
    const idx = op & 0x1f, scale = (op >>> 7) & 7, mode = (op >>> 10) & 0xf;
    let d;
    switch (mode) {
      case 0x4: return this.r[abase];
      case 0x5: d = this.rd32(this.IP); this.IP = (this.IP + 4) >>> 0; return (d + this.IP) >>> 0;
      case 0x7: return (this.r[abase] + (this.r[idx] << scale)) >>> 0;
      case 0xc: d = this.rd32(this.IP); this.IP = (this.IP + 4) >>> 0; return d;
      case 0xd: d = this.rd32(this.IP); this.IP = (this.IP + 4) >>> 0; return (d + this.r[abase]) >>> 0;
      case 0xe: d = this.rd32(this.IP); this.IP = (this.IP + 4) >>> 0; return (d + (this.r[idx] << scale)) >>> 0;
      case 0xf: d = this.rd32(this.IP); this.IP = (this.IP + 4) >>> 0; return (d + this.r[abase] + (this.r[idx] << scale)) >>> 0;
    }
    this.unhandled(op, 'MEMB mode ' + mode);
    return 0;
  }

  // ---- calls / returns ----
  doCall(adr, type, stack) {
    const r = this.r;
    r[RIP] = this.IP;
    // save the caller's local registers into its frame
    const fp = r[FP] & ~0x3f;
    for (let i = 0; i < 16; i++) this.wr32(fp + i * 4, r[i]);
    this.IP = adr >>> 0;
    r[PFP] = ((r[FP] & ~7) | type) >>> 0;
    if (type === 7) r[SP] = stack >>> 0;
    r[FP] = ((r[SP] + 63) & ~63) >>> 0;
    r[SP] = (r[FP] + 64) >>> 0;
    this.icount -= 9;
  }

  doRet0() {
    const r = this.r;
    r[FP] = (r[PFP] & ~0x3f) >>> 0;
    const fp = r[FP];
    for (let i = 0; i < 16; i++) r[i] = this.rd32(fp + i * 4);
    this.IP = r[RIP];
  }

  doRet() {
    this.icount -= 7;
    switch (this.r[PFP] & 7) {
      case 0: this.doRet0(); break;
      case 7: {
        const x = this.rd32(this.r[FP] - 16), y = this.rd32(this.r[FP] - 12);
        this.doRet0();
        this.AC = y; this.PC = x;
        this.checkPendingIrqs();
        break;
      }
      default:
        // supervisor return (type 2/3): treat as local return, restore PC trace/mode bits
        this.doRet0();
        break;
    }
  }

  // ---- interrupts ----
  takeInterrupt(vector, lvl) {
    const intTab = this.rd32(this.PRCB + 20);
    const intSP = this.rd32(this.PRCB + 24);
    const irqv = this.rd32(intTab + 36 + (vector - 8) * 4);
    let sp = (this.PC & 0x2000) ? this.r[SP] : intSP;
    sp = ((sp + 63) & ~63) + 64;
    this.doCall(irqv, 7, sp >>> 0);
    this.wr32(this.r[FP] - 16, this.PC);
    this.wr32(this.r[FP] - 12, this.AC);
    this.wr32(this.r[FP] - 8, vector - 8);
    this.PC = ((this.PC & ~0x001f0401) | (lvl << 16) | 0x2002) >>> 0;
  }

  checkImmediateIrqs() {
    const cpuPri = (this.PC >>> 16) & 0x1f;
    if (this.immIrq && (cpuPri < this.immPri || this.immPri === 31)) {
      this.immIrq = 0;
      this.takeInterrupt(this.immVector, this.immPri);
    }
  }

  checkPendingIrqs() {
    const intTab = this.rd32(this.PRCB + 20);
    const cpuPri = (this.PC >>> 16) & 0x1f;
    let pending = this.rd32(intTab);
    const lvlmask = [0xff, 0xff00, 0xff0000, 0xff000000];
    for (let lvl = 31; lvl >= 0; lvl--) {
      if ((pending & (1 << lvl)) && (cpuPri < lvl || lvl === 31)) {
        const word = ((lvl >> 2) * 4) + 4;
        const wl = (lvl & 3) * 8, wh = wl + 7;
        let vword = this.rd32(intTab + word);
        let take = -1;
        for (let b = wh; b >= wl; b--) {
          if (vword & (1 << b)) { vword &= ~(1 << b); this.wr32(intTab + word, vword); take = b; break; }
        }
        if (take === -1) { pending &= ~(1 << lvl); this.wr32(intTab, pending); return; }
        if (!(vword & lvlmask[lvl & 3])) { pending &= ~(1 << lvl); this.wr32(intTab, pending); }
        take += (lvl >> 2) * 32;
        this.takeInterrupt(take, lvl);
        return;
      }
    }
  }

  // Post an interrupt vector (software IAC or external line). Taken right away
  // if its priority beats the current one, otherwise recorded as pending.
  postInterrupt(vector) {
    if (vector < 8) return;
    const pri = vector >> 3;
    const cpuPri = (this.PC >>> 16) & 0x1f;
    if ((cpuPri < pri || pri === 31) && !this.immIrq) {
      this.takeInterrupt(vector, pri);
      return;
    }
    const intTab = this.rd32(this.PRCB + 20);
    this.wr32(intTab, this.rd32(intTab) | (1 << pri));
    const w = ((vector >> 5) * 4) + 4;
    this.wr32(intTab + w, this.rd32(intTab + w) | (1 << (vector & 31)));
  }

  setIrq(line, state) {
    if (this.irqLine[line] === state) return;
    this.irqLine[line] = state;
    if (!state) return;
    const vector = (this.ICR >>> (line * 8)) & 0xff;
    if (!vector) return;
    const intTab = this.rd32(this.PRCB + 20);
    const cpuPri = (this.PC >>> 16) & 0x1f;
    const pri = vector >> 3;
    if ((cpuPri < pri || pri === 31) && !this.immIrq) {
      this.immIrq = 1; this.immVector = vector; this.immPri = pri;
    } else {
      this.wr32(intTab, this.rd32(intTab) | (1 << pri));
      const w = ((vector >> 5) * 4) + 4;
      this.wr32(intTab + w, this.rd32(intTab + w) | (1 << (vector & 31)));
    }
  }

  sendIac(adr) {
    const i0 = this.rd32(adr), i1 = this.rd32(adr + 4), i2 = this.rd32(adr + 8), i3 = this.rd32(adr + 12);
    switch (i0 >>> 24) {
      case 0x40: this.postInterrupt((i0 >>> 16) & 0xff); break;   // generate (software) interrupt
      case 0x41: this.checkPendingIrqs(); break;        // test pending
      case 0x80: this.wr32(i1, this.SAT); this.wr32(i1 + 4, this.PRCB); break;
      case 0x89: case 0x8f: case 0x91: case 0x92: break;
      case 0x93:                                         // reinitialize processor
        // A real reinit behaves like reset without self-test: supervisor mode,
        // priority 31 (interrupts masked), fresh interrupt stack from the PRCB.
        this.SAT = i1; this.PRCB = i2; this.IP = i3;
        this.PC = 0x001f2002; this.AC = 0; this.immIrq = 0;
        this.r[FP] = this.rd32(this.PRCB + 24);
        this.r[SP] = (this.r[FP] + 64) >>> 0;
        this.r[PFP] = 0;
        break;
      default: this.unhandled(i0, 'IAC');
    }
  }

  unhandled(op, what) {
    if (this.onUnhandled) this.onUnhandled(this.PIP, op, what);
    else throw new Error('i960: unhandled ' + what + ' op=' + (op >>> 0).toString(16) + ' at ' + this.PIP.toString(16));
  }

  // ---- main loop ----
  run(cycles) {
    this.icount += cycles;
    this.checkImmediateIrqs();
    const r = this.r;
    while (this.icount > 0 && !this.halted) {
      this.PIP = this.IP;
      const op = this.rd32(this.IP);
      if (this.trace) this.trace(this.IP, op);
      this.IP = (this.IP + 4) >>> 0;
      this.icount -= 2;
      this.ninstr++;
      this.exec(op, r);
    }
  }

  branchIf(op, mask) { if (this.AC & mask) this.IP = (this.IP + sext(op & 0xfffffc, 24) - 4) >>> 0; }
  cobrIf(op, mask) { if (this.AC & mask) this.IP = (this.IP + sext(op & 0x1ffc, 13) - 4) >>> 0; }

  exec(op, r) {
    let t1, t2;
    switch (op >>> 24) {
      // ---------------- CTRL ----------------
      case 0x08: this.IP = (this.IP + sext(op & 0xfffffc, 24) - 4) >>> 0; return;
      case 0x09: this.doCall((this.IP + sext(op & 0xfffffc, 24) - 4) >>> 0, 0, r[SP]); return;
      case 0x0a: this.doRet(); return;
      case 0x0b: r[G14] = this.IP; this.IP = (this.IP + sext(op & 0xfffffc, 24) - 4) >>> 0; return;
      case 0x10: if (!(this.AC & 7)) this.IP = (this.IP + sext(op & 0xfffffc, 24) - 4) >>> 0; return;
      case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16: case 0x17:
        this.branchIf(op, (op >>> 24) & 7); return;
      case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e: case 0x1f: {
        const m = (op >>> 24) & 7;
        const take = m === 0 ? !(this.AC & 7) : (this.AC & m);
        if (take) this.unhandled(op, 'fault instruction');
        return;
      }
      // ---------------- COBR ----------------
      case 0x20: r[(op >>> 19) & 0x1f] = (this.AC & 7) ? 0 : 1; return;
      case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27:
        r[(op >>> 19) & 0x1f] = (this.AC & ((op >>> 24) & 7)) ? 1 : 0; return;
      case 0x30: // bbc
        t1 = this.csrc1(op) & 0x1f; t2 = this.csrc2(op);
        if (!(t2 & (1 << t1))) { this.AC = (this.AC & ~7) | 2; this.IP = (this.IP + sext(op & 0x1ffc, 13) - 4) >>> 0; }
        else this.AC &= ~7;
        return;
      case 0x37: // bbs
        t1 = this.csrc1(op) & 0x1f; t2 = this.csrc2(op);
        if (t2 & (1 << t1)) { this.AC = (this.AC & ~7) | 2; this.IP = (this.IP + sext(op & 0x1ffc, 13) - 4) >>> 0; }
        else this.AC &= ~7;
        return;
      case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36:
        this.cmpU(this.csrc1(op), this.csrc2(op)); this.cobrIf(op, (op >>> 24) & 7); return;
      case 0x38: this.cmpS(this.csrc1(op), this.csrc2(op)); return;
      case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x3d: case 0x3e: case 0x3f:
        this.cmpS(this.csrc1(op), this.csrc2(op)); this.cobrIf(op, (op >>> 24) & 7); return;
      // ---------------- REG ----------------
      case 0x58: return this.op58(op);
      case 0x59: return this.op59(op);
      case 0x5a: return this.op5a(op);
      case 0x5b: return this.op5b(op);
      case 0x5c:
        if (((op >>> 7) & 0xf) === 0xc) { this.setDst(op, this.src1(op)); return; }
        break;
      case 0x5d: case 0x5e: case 0x5f:
        if (((op >>> 7) & 0xf) === 0xc) {
          const n = (op >>> 24) === 0x5d ? 2 : (op >>> 24) === 0x5e ? 3 : 4;
          const d = (op >>> 19) & (n === 2 ? 0x1e : 0x1c);
          if (op & 0x800) { const lit = op & 0x1f; for (let i = 0; i < n; i++) r[d + i] = lit; }
          else { const s = op & 0x1f; const tmp = []; for (let i = 0; i < n; i++) tmp.push(r[(s + i) & 31]); for (let i = 0; i < n; i++) r[d + i] = tmp[i]; }
          return;
        }
        break;
      case 0x60: return this.op60(op);
      case 0x61: return this.op61(op);
      case 0x64: return this.op64(op);
      case 0x65: return this.op65(op);
      case 0x66: return this.op66(op);
      case 0x67: return this.op67(op);
      case 0x70: return this.op70(op);
      case 0x74: return this.op74(op);
      // ---------------- MEM ----------------
      case 0x80: { const a = this.ea(op); r[(op >>> 19) & 0x1f] = this.rd8(a); return; }
      case 0x82: { const a = this.ea(op); this.wr8(a, r[(op >>> 19) & 0x1f]); return; }
      case 0x84: this.IP = this.ea(op); return;
      case 0x85: { t1 = this.ea(op); r[(op >>> 19) & 0x1f] = this.IP; this.IP = t1; return; }
      case 0x86: { t1 = this.ea(op); this.doCall(t1, 0, r[SP]); return; }
      case 0x88: { const a = this.ea(op); r[(op >>> 19) & 0x1f] = this.rd16(a); return; }
      case 0x8a: { const a = this.ea(op); this.wr16(a, r[(op >>> 19) & 0x1f]); return; }
      case 0x8c: r[(op >>> 19) & 0x1f] = this.ea(op); return;
      case 0x90: { const a = this.ea(op); r[(op >>> 19) & 0x1f] = this.rd32(a); return; }
      case 0x92: { const a = this.ea(op); this.wr32(a, r[(op >>> 19) & 0x1f]); return; }
      case 0x98: return this.ldn(op, 2, 0x1e);
      case 0xa0: return this.ldn(op, 3, 0x1c);
      case 0xb0: return this.ldn(op, 4, 0x1c);
      case 0x9a: return this.stn(op, 2, 0x1e);
      case 0xa2: return this.stn(op, 3, 0x1c);
      case 0xb2: return this.stn(op, 4, 0x1c);
      case 0xc0: { const a = this.ea(op); r[(op >>> 19) & 0x1f] = (this.rd8(a) << 24) >> 24; return; }
      case 0xc2: { const a = this.ea(op); this.wr8(a, r[(op >>> 19) & 0x1f]); return; }
      case 0xc8: { const a = this.ea(op); r[(op >>> 19) & 0x1f] = (this.rd16(a) << 16) >> 16; return; }
      case 0xca: { const a = this.ea(op); this.wr16(a, r[(op >>> 19) & 0x1f]); return; }
    }
    this.unhandled(op, 'opcode');
  }

  ldn(op, n, mask) {
    let a = this.ea(op); const d = (op >>> 19) & mask;
    const burst = this.bus.isBurst(a);
    for (let i = 0; i < n; i++) { this.r[d + i] = this.rd32(a); if (burst) a = (a + 4) >>> 0; }
  }
  stn(op, n, mask) {
    let a = this.ea(op); const d = (op >>> 19) & mask;
    const burst = this.bus.isBurst(a);
    for (let i = 0; i < n; i++) { this.wr32(a, this.r[d + i]); if (burst) a = (a + 4) >>> 0; }
  }

  op58(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    let v;
    switch ((op >>> 7) & 0xf) {
      case 0x0: v = t2 ^ (1 << (t1 & 31)); break;
      case 0x1: v = t2 & t1; break;
      case 0x2: v = t2 & ~t1; break;
      case 0x3: v = t2 | (1 << (t1 & 31)); break;
      case 0x4: v = ~t2 & t1; break;
      case 0x6: v = t2 ^ t1; break;
      case 0x7: v = t2 | t1; break;
      case 0x8: v = ~t2 & ~t1; break;
      case 0x9: v = ~(t2 ^ t1); break;
      case 0xa: v = ~t1; break;
      case 0xb: v = t2 | ~t1; break;
      case 0xc: v = t2 & ~(1 << (t1 & 31)); break;
      case 0xd: v = ~t2 | t1; break;
      case 0xe: v = ~t2 | ~t1; break;
      case 0xf: v = (this.AC & 2) ? (t2 | (1 << (t1 & 31))) : (t2 & ~(1 << (t1 & 31))); break;
      default: return this.unhandled(op, '58');
    }
    this.setDst(op, v);
  }

  op59(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    let v;
    switch ((op >>> 7) & 0xf) {
      case 0x0: case 0x1: v = t2 + t1; break;
      case 0x2: case 0x3: v = t2 - t1; break;
      case 0x8: v = t1 >= 32 ? 0 : t2 >>> t1; break;
      case 0xa: // shrdi
        if (t1 >= 32) v = 0;
        else if ((t2 | 0) < 0) v = (t2 & ((1 << t1) - 1)) ? ((t2 | 0) >> t1) + 1 : (t2 | 0) >> t1;
        else v = t2 >>> t1;
        break;
      case 0xb: v = t1 >= 32 ? ((t2 | 0) < 0 ? -1 : 0) : (t2 | 0) >> t1; break;
      case 0xc: case 0xe: v = t1 >= 32 ? 0 : t2 << t1; break;
      case 0xd: { const n = t1 & 31; v = n ? ((t2 << n) | (t2 >>> (32 - n))) : t2; break; }
      default: return this.unhandled(op, '59');
    }
    this.setDst(op, v);
  }

  op5a(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    switch ((op >>> 7) & 0xf) {
      case 0x0: this.cmpU(t1, t2); return;
      case 0x1: this.cmpS(t1, t2); return;
      case 0x2: if (!(this.AC & 4)) this.AC = (this.AC & ~7) | ((t1 >>> 0) <= (t2 >>> 0) ? 2 : 1); return;
      case 0x3: if (!(this.AC & 4)) this.AC = (this.AC & ~7) | ((t1 | 0) <= (t2 | 0) ? 2 : 1); return;
      case 0x4: this.cmpU(t1, t2); this.setDst(op, t2 + 1); return;
      case 0x5: this.cmpS(t1, t2); this.setDst(op, t2 + 1); return;
      case 0x6: this.cmpU(t1, t2); this.setDst(op, t2 - 1); return;
      case 0x7: this.cmpS(t1, t2); this.setDst(op, t2 - 1); return;
      case 0xc:
        this.AC &= ~7;
        if (((t1 ^ t2) & 0xff000000) === 0 || ((t1 ^ t2) & 0xff0000) === 0 || ((t1 ^ t2) & 0xff00) === 0 || ((t1 ^ t2) & 0xff) === 0) this.AC |= 2;
        return;
      case 0xe: this.AC = (t2 & (1 << (t1 & 31))) ? ((this.AC & ~7) | 2) : (this.AC & ~7); return;
    }
    this.unhandled(op, '5a');
  }

  op5b(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    const c = (this.AC >>> 1) & 1;
    switch ((op >>> 7) & 0xf) {
      case 0x0: {
        const res = t2 + t1 + c;
        const lo = res >>> 0;
        this.setDst(op, lo);
        this.AC &= ~3;
        if (res > 0xffffffff) this.AC |= 2;
        if (((lo ^ t1) & (lo ^ t2)) & 0x80000000) this.AC |= 1;
        return;
      }
      case 0x2: {
        const nt1 = (~t1) >>> 0;
        const res = t2 + nt1 + c;
        const lo = res >>> 0;
        this.setDst(op, lo);
        this.AC &= ~7;
        if (res > 0xffffffff) this.AC |= 2;
        if (((t2 ^ t1) & (t2 ^ lo)) & 0x80000000) this.AC |= 1;
        return;
      }
    }
    this.unhandled(op, '5b');
  }

  op60(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    switch ((op >>> 7) & 0xf) {
      case 0x0: // synmov
        if (t1 === 0xff000004) this.ICR = this.rd32(t2);
        else this.wr32(t1, this.rd32(t2));
        this.AC = (this.AC & ~7) | 2;
        return;
      case 0x1: // synmovl
        this.wr32(t1, this.rd32(t2)); this.wr32(t1 + 4, this.rd32(t2 + 4));
        this.AC = (this.AC & ~7) | 2;
        return;
      case 0x2: // synmovq
        if (t1 === 0xff000010) this.sendIac(t2);
        else for (let i = 0; i < 16; i += 4) this.wr32(t1 + i, this.rd32(t2 + i));
        this.AC = (this.AC & ~7) | 2;
        return;
    }
    this.unhandled(op, '60');
  }

  op61(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    const d = (op >>> 19) & 0x1f;
    switch ((op >>> 7) & 0xf) {
      case 0x0: { // atmod
        const a = t1 & ~3; const tmp = this.rd32(a);
        this.wr32(a, (this.r[d] & t2) | (tmp & ~t2)); this.r[d] = tmp; return;
      }
      case 0x2: { // atadd
        const a = t1 & ~3; const tmp = this.rd32(a);
        this.wr32(a, tmp + t2); this.r[d] = tmp; return;
      }
      case 0x5: // synld
        this.r[d] = this.rd32(t1); this.AC = (this.AC & ~7) | 2; return;
    }
    this.unhandled(op, '61');
  }

  op64(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    switch ((op >>> 7) & 0xf) {
      case 0x0: case 0x1: { // spanbit / scanbit
        const v = ((op >>> 7) & 0xf) === 0 ? (~t1) >>> 0 : t1 >>> 0;
        this.AC &= ~7;
        if (v) { this.AC |= 2; this.setDst(op, 31 - Math.clz32(v)); } else this.setDst(op, 0xffffffff);
        return;
      }
      case 0x4: // dmovt
        this.setDst(op, t1);
        this.AC &= ~7;
        if ((t1 & 0xff) < 0x30 || (t1 & 0xff) > 0x39) this.AC |= 2;
        return;
      case 0x5: { // modac
        const old = this.AC;
        this.AC = ((this.AC & ~t1) | (t2 & t1)) >>> 0;
        this.setDst(op, old);
        return;
      }
    }
    this.unhandled(op, '64');
  }

  op65(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    const d = (op >>> 19) & 0x1f;
    switch ((op >>> 7) & 0xf) {
      case 0x0: this.r[d] = ((t2 & t1) | (this.r[d] & ~t1)) >>> 0; return;               // modify
      case 0x1: {                                                                         // extract
        const len = t2;
        const mask = len >= 32 ? 0xffffffff : ((1 << len) - 1) >>> 0;
        this.r[d] = ((this.r[d] >>> (t1 & 31)) & mask) >>> 0; return;
      }
      case 0x4: { const old = this.TC || 0; this.TC = ((old & ~t2) | (this.r[d] & t2)) >>> 0; this.r[d] = old; return; } // modtc
      case 0x5: { // modpc
        const old = this.PC;
        this.PC = ((this.PC & ~t2) | (this.r[d] & t2)) >>> 0;
        this.r[d] = old;
        if (((old >>> 16) & 0x1f) > ((this.PC >>> 16) & 0x1f)) this.checkPendingIrqs();
        return;
      }
    }
    this.unhandled(op, '65');
  }

  op66(op) {
    switch ((op >>> 7) & 0xf) {
      case 0x0: { // calls
        const t1 = this.src1(op);
        const spt = this.rd32(this.SAT + 152);
        const e = this.rd32(spt + 48 + t1 * 4);
        this.doCall(e & ~3, 0, this.r[SP]);
        return;
      }
      case 0xb: case 0xc: return;           // mark / fmark (trace)
      case 0xd: return;                      // flushreg: frames are always in memory here
      case 0xf: return;                      // syncf
    }
    this.unhandled(op, '66');
  }

  op67(op) {
    const t1 = this.src1(op);
    const d = (op >>> 19) & 0x1f;
    switch ((op >>> 7) & 0xf) {
      case 0x0: { // emul
        const p = BigInt(t1 >>> 0) * BigInt(this.src2(op) >>> 0);
        this.r[d & 0x1e] = Number(p & 0xffffffffn); this.r[(d & 0x1e) + 1] = Number(p >> 32n);
        return;
      }
      case 0x1: { // ediv
        const s2 = (op & 0x1000) ? BigInt((op >>> 14) & 0x1f)
          : (BigInt(this.r[(op >>> 14) & 0x1f]) | (BigInt(this.r[((op >>> 14) & 0x1f) + 1]) << 32n));
        const s1 = BigInt(t1 >>> 0);
        if (s1 === 0n) { this.unhandled(op, 'ediv by zero'); return; }
        this.r[d & 0x1e] = Number((s2 % s1) & 0xffffffffn);
        this.r[(d & 0x1e) + 1] = Number((s2 / s1) & 0xffffffffn);
        return;
      }
    }
    this.unhandled(op, '67');
  }

  op70(op) {
    const t1 = this.src1(op), t2 = this.src2(op);
    switch ((op >>> 7) & 0xf) {
      case 0x1: this.setDst(op, Math.imul(t2, t1)); return;
      case 0x8: this.setDst(op, t1 ? (t2 >>> 0) % (t1 >>> 0) : 0); return;
      case 0xb: this.setDst(op, t1 ? Math.floor((t2 >>> 0) / (t1 >>> 0)) : 0); return;
    }
    this.unhandled(op, '70');
  }

  op74(op) {
    const t1 = this.src1(op) | 0, t2 = this.src2(op) | 0;
    switch ((op >>> 7) & 0xf) {
      case 0x1: this.setDst(op, Math.imul(t2, t1)); return;
      case 0x8: this.setDst(op, t1 ? t2 % t1 : 0); return;
      case 0x9: {
        if (!t1) { this.setDst(op, 0); return; }
        let dd = t2 % t1;
        if (((t1 ^ t2) < 0) && dd !== 0) dd += t1;
        this.setDst(op, dd); return;
      }
      case 0xb: this.setDst(op, t1 ? Math.trunc(t2 / t1) : 0); return;
    }
    this.unhandled(op, '74');
  }
}

if (typeof module !== 'undefined') module.exports = { I960 };
else window.I960 = I960;
