// Intel MCS-48 family core (8039 / 8048): the CPU in IGT's Draw 80 Poker.
// run(n) executes n machine cycles (one machine cycle = 15 oscillator clocks).
// Semantics follow the MCS-48 user's manual (and MAME's mcs48.cpp where the manual is vague).
'use strict';
(function () {

class MCS48 {
  // bus: { rom(addr) -> byte (program memory, 12-bit), xread(a), xwrite(a, v), p1r(), p1w(v), p2r(), p2w(v),
  //        busr(), busw(v), prog(state), t0(), t1() }
  constructor(bus, ramSize) {
    this.bus = bus;
    this.ram = new Uint8Array(ramSize || 128);
    this.ramMask = (ramSize || 128) - 1;
    this.reset();
  }
  reset() {
    this.ram.fill(0);
    this.pc = 0; this.a = 0; this.psw = 0x08; this.a11 = 0; this.p1 = 0xff; this.p2 = 0xff;
    this.timer = 0; this.prescaler = 0; this.timerOn = false; this.counterOn = false; this.tflag = false; this.tovf = false;
    this.xirqEn = false; this.tirqEn = false; this.irqInProgress = false; this.irqState = false;
    this.f1 = 0; this.cycles = 0; this.irqPolled = false; this.prevpc = 0;
    this.t1hist = 0;
  }
  get rb() { return (this.psw & 0x10) ? 24 : 0; }
  R(n) { return this.ram[this.rb + n]; }
  setR(n, v) { this.ram[this.rb + n] = v & 0xff; }
  ramR(a) { return this.ram[a & this.ramMask]; }
  ramW(a, v) { this.ram[a & this.ramMask] = v & 0xff; }
  setIrq(on) { this.irqState = on; }

  // opcode fetch: PC increments through the full 11 bits (A11 latched separately) like the real chip
  fetchOp() { const v = this.bus.rom(this.pc) & 0xff; this.pc = ((this.pc + 1) & 0x7ff) | (this.pc & 0x800); return v; }
  arg() { const v = this.bus.rom(this.pc) & 0xff; this.pc = ((this.pc + 1) & 0x7ff) | (this.pc & 0x800); return v; }

  pushPcPsw() {
    const sp = this.psw & 7;
    this.ramW(8 + 2 * sp, this.pc);
    this.ramW(9 + 2 * sp, ((this.pc >> 8) & 0x0f) | (this.psw & 0xf0));
    this.psw = (this.psw & 0xf0) | ((sp + 1) & 7);
  }
  pullPc() {
    const sp = (this.psw - 1) & 7;
    this.pc = this.ramR(8 + 2 * sp) | (this.ramR(9 + 2 * sp) << 8);
    this.pc &= this.irqInProgress ? 0x7ff : 0xfff;
    this.psw = (this.psw & 0xf0) | sp;
  }
  pullPcPsw() {
    const sp = (this.psw - 1) & 7;
    this.pc = this.ramR(8 + 2 * sp) | (this.ramR(9 + 2 * sp) << 8);
    this.psw = ((this.pc >> 8) & 0xf0) | sp;
    this.pc &= this.irqInProgress ? 0x7ff : 0xfff;
  }
  jmp(addr) { this.pc = addr | (this.irqInProgress ? 0 : this.a11); }
  call(addr) { this.pushPcPsw(); this.jmp(addr); }
  add(d, c) {
    const t = this.a + d + c, t4 = (this.a & 15) + (d & 15) + c;
    this.psw = (this.psw & 0x3f) | ((t4 << 2) & 0x40) | ((t >> 1) & 0x80);
    this.a = t & 0xff;
  }

  burn(n) {
    this.cycles += n;
    if (this.timerOn) {
      const old = this.timer;
      this.prescaler += n;
      this.timer = (this.timer + (this.prescaler >> 5)) & 0xff;
      this.prescaler &= 31;
      if (this.timer < old) { this.tflag = true; if (this.tirqEn) this.tovf = true; }
    } else if (this.counterOn) {
      for (let i = 0; i < n; i++) {
        this.t1hist = ((this.t1hist << 1) | (this.bus.t1 ? this.bus.t1() & 1 : 0)) & 3;
        if (this.t1hist === 2) { this.timer = (this.timer + 1) & 0xff; if (this.timer === 0) { this.tflag = true; if (this.tirqEn) this.tovf = true; } }
      }
    }
  }

  checkIrqs() {
    if (this.irqInProgress) return;
    if (this.irqState && this.xirqEn) {
      this.burn(2); this.irqInProgress = true;
      if (this.irqPolled) { this.pc = ((this.prevpc + 1) & 0x7ff) | (this.prevpc & 0x800); this.jccTaken(); }
      this.call(0x03);
    } else if (this.tovf && this.tirqEn) {
      this.burn(2); this.irqInProgress = true; this.call(0x07); this.tovf = false;
    }
  }
  jccTaken() { const pch = this.pc & 0xf00; const off = this.arg(); this.pc = pch | off; }

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) {
      this.prevpc = this.pc;
      this.irqPolled = false;
      this.execute();
      this.checkIrqs();
    }
  }

  // conditional jump: the target is in the page holding the operand byte
  cj(cond) {
    const pch = this.pc & 0xf00;
    const off = this.arg();
    if (cond) this.pc = pch | off;
  }
  port(n) { return n === 1 ? this.p1 : this.p2; }
  expander(op, port) {
    this.p2 = (this.p2 & 0xf0) | (op << 2) | (port & 3);
    this.bus.p2w(this.p2);
    this.bus.prog(0);
    if (op !== 0) { this.p2 = (this.p2 & 0xf0) | (this.a & 15); this.bus.p2w(this.p2); }
    else { this.p2 |= 0x0f; this.bus.p2w(this.p2); this.a = (this.bus.p2r ? this.bus.p2r() : this.p2) & 15; }
    this.bus.prog(1);
  }

  execute() {
    const op = this.fetchOp();
    const R = n => this.ram[this.rb + n];
    const sR = (n, v) => { this.ram[this.rb + n] = v & 0xff; };
    const lo = op & 7, hi = op >> 3;
    this.burn(1);                      // every instruction takes at least one cycle
    // register-operand groups (op & 0xf8)
    switch (op & 0xf8) {
      case 0x18: sR(lo, R(lo) + 1); return;                             // INC Rn
      case 0x28: { const t = this.a; this.a = R(lo); sR(lo, t); return; } // XCH A,Rn
      case 0x48: this.a |= R(lo); return;
      case 0x58: this.a &= R(lo); return;
      case 0x68: this.add(R(lo), 0); return;
      case 0x78: this.add(R(lo), (this.psw >> 7) & 1); return;
      case 0xa8: sR(lo, this.a); return;                                // MOV Rn,A
      case 0xb8: this.burn(1); sR(lo, this.arg()); return;              // MOV Rn,#
      case 0xc8: sR(lo, R(lo) - 1); return;                             // DEC Rn
      case 0xd8: this.a ^= R(lo); return;
      case 0xe8: { this.burn(1); const v = (R(lo) - 1) & 0xff; sR(lo, v); this.cj(v !== 0); return; }   // DJNZ
      case 0xf8: this.a = R(lo); return;                                // MOV A,Rn
    }
    switch (op) {
      case 0x00: return;
      case 0x02: this.burn(1); this.bus.busw(this.a); return;                                   // OUTL BUS,A
      case 0x03: this.burn(1); this.add(this.arg(), 0); return;                                 // ADD A,#
      case 0x05: this.xirqEn = true; return;                                                    // EN I
      case 0x07: this.a = (this.a - 1) & 0xff; return;                                          // DEC A
      case 0x08: this.burn(1); this.a = this.bus.busr(); return;                                // INS A,BUS
      case 0x09: this.burn(1); this.a = (this.bus.p1r ? this.bus.p1r() : this.p1) & this.p1; return;  // IN A,P1
      case 0x0a: this.burn(1); this.a = (this.bus.p2r ? this.bus.p2r() : this.p2) & this.p2; return;  // IN A,P2
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: this.burn(1); this.expander(0, lo); return;    // MOVD A,Pn
      case 0x10: case 0x11: { const a = R(op & 1); this.ramW(a, this.ramR(a) + 1); return; }     // INC @Rr
      case 0x12: case 0x32: case 0x52: case 0x72: case 0x92: case 0xb2: case 0xd2: case 0xf2:    // JBb
        this.burn(1); this.cj((this.a >> (op >> 5)) & 1); return;
      case 0x13: this.burn(1); this.add(this.arg(), (this.psw >> 7) & 1); return;               // ADDC A,#
      case 0x15: this.xirqEn = false; return;                                                   // DIS I
      case 0x16: this.burn(1); { const f = this.tflag; this.tflag = false; this.cj(f); } return; // JTF
      case 0x17: this.a = (this.a + 1) & 0xff; return;                                          // INC A
      case 0x20: case 0x21: { const a = R(op & 1); const t = this.a; this.a = this.ramR(a); this.ramW(a, t); return; }   // XCH A,@Rr
      case 0x23: this.burn(1); this.a = this.arg(); return;                                     // MOV A,#
      case 0x25: this.tirqEn = true; return;                                                    // EN TCNTI
      case 0x26: this.burn(1); this.cj(!(this.bus.t0 && this.bus.t0())); return;                // JNT0
      case 0x27: this.a = 0; return;                                                            // CLR A
      case 0x30: case 0x31: { const a = R(op & 1); const t = this.a; this.a = (this.a & 0xf0) | (this.ramR(a) & 15); this.ramW(a, (this.ramR(a) & 0xf0) | (t & 15)); return; }   // XCHD
      case 0x35: this.tirqEn = false; this.tovf = false; return;                                // DIS TCNTI
      case 0x36: this.burn(1); this.cj(!!(this.bus.t0 && this.bus.t0())); return;               // JT0
      case 0x37: this.a ^= 0xff; return;                                                        // CPL A
      case 0x39: this.burn(1); this.p1 = this.a; this.bus.p1w(this.p1); return;                 // OUTL P1,A
      case 0x3a: this.burn(1); this.p2 = this.a; this.bus.p2w(this.p2); return;                 // OUTL P2,A
      case 0x3c: case 0x3d: case 0x3e: case 0x3f: this.burn(1); this.expander(1, lo); return;    // MOVD Pn,A
      case 0x40: case 0x41: this.a |= this.ramR(R(op & 1)); return;
      case 0x42: this.a = this.timer; return;                                                   // MOV A,T
      case 0x43: this.burn(1); this.a |= this.arg(); return;
      case 0x45: this.counterOn = true; this.timerOn = false; this.t1hist = (this.bus.t1 ? this.bus.t1() & 1 : 0); return;   // STRT CNT
      case 0x46: this.burn(1); this.cj(!(this.bus.t1 && this.bus.t1())); return;                // JNT1
      case 0x47: this.a = ((this.a << 4) | (this.a >> 4)) & 0xff; return;                       // SWAP A
      case 0x50: case 0x51: this.a &= this.ramR(R(op & 1)); return;
      case 0x53: this.burn(1); this.a &= this.arg(); return;
      case 0x55: this.timerOn = true; this.counterOn = false; this.prescaler = 0; return;       // STRT T
      case 0x56: this.burn(1); this.cj(!!(this.bus.t1 && this.bus.t1())); return;               // JT1
      case 0x57: {                                                                              // DA A
        if ((this.a & 15) > 9 || (this.psw & 0x40)) { if (this.a > 0xf9) this.psw |= 0x80; this.a = (this.a + 6) & 0xff; }
        if ((this.a >> 4) > 9 || (this.psw & 0x80)) { this.a = (this.a + 0x60) & 0xff; this.psw |= 0x80; }
        return; }
      case 0x60: case 0x61: this.add(this.ramR(R(op & 1)), 0); return;
      case 0x62: this.timer = this.a; return;                                                   // MOV T,A
      case 0x65: this.timerOn = false; this.counterOn = false; return;                          // STOP TCNT
      case 0x67: { const c = (this.psw >> 7) & 1; this.psw = (this.psw & 0x7f) | ((this.a & 1) << 7); this.a = (this.a >> 1) | (c << 7); return; }   // RRC A
      case 0x70: case 0x71: this.add(this.ramR(R(op & 1)), (this.psw >> 7) & 1); return;
      case 0x75: return;                                                                        // ENT0 CLK
      case 0x76: this.burn(1); this.cj(!!this.f1); return;                                      // JF1
      case 0x77: this.a = ((this.a >> 1) | (this.a << 7)) & 0xff; return;                       // RR A
      case 0x80: case 0x81: this.burn(1); this.a = this.bus.xread(R(op & 1)) & 0xff; return;    // MOVX A,@Rr
      case 0x83: this.burn(1); this.pullPc(); return;                                           // RET
      case 0x85: this.psw &= ~0x20; return;                                                     // CLR F0
      case 0x86: this.burn(1); this.irqPolled = !this.irqState; this.cj(this.irqState); return; // JNI
      case 0x88: this.burn(1); { const v = this.arg(); this.bus.busw(this.bus.busr() | v); } return;                  // ORL BUS,#
      case 0x89: this.burn(1); this.p1 |= this.arg(); this.bus.p1w(this.p1); return;            // ORL P1,#
      case 0x8a: this.burn(1); this.p2 |= this.arg(); this.bus.p2w(this.p2); return;            // ORL P2,#
      case 0x8c: case 0x8d: case 0x8e: case 0x8f: this.burn(1); this.expander(2, lo); return;    // ORLD
      case 0x90: case 0x91: this.burn(1); this.bus.xwrite(R(op & 1), this.a); return;           // MOVX @Rr,A
      case 0x93: this.burn(1); this.irqInProgress = false; this.pullPcPsw(); return;            // RETR
      case 0x95: this.psw ^= 0x20; return;                                                      // CPL F0
      case 0x96: this.burn(1); this.cj(this.a !== 0); return;                                   // JNZ
      case 0x97: this.psw &= 0x7f; return;                                                      // CLR C
      case 0x98: this.burn(1); { const v = this.arg(); this.bus.busw(this.bus.busr() & v); } return;   // ANL BUS,#
      case 0x99: this.burn(1); this.p1 &= this.arg(); this.bus.p1w(this.p1); return;            // ANL P1,#
      case 0x9a: this.burn(1); this.p2 &= this.arg(); this.bus.p2w(this.p2); return;            // ANL P2,#
      case 0x9c: case 0x9d: case 0x9e: case 0x9f: this.burn(1); this.expander(3, lo); return;    // ANLD
      case 0xa0: case 0xa1: this.ramW(R(op & 1), this.a); return;                               // MOV @Rr,A
      case 0xa3: this.burn(1); this.a = this.bus.rom((this.pc & 0xf00) | this.a) & 0xff; return; // MOVP A,@A
      case 0xa5: this.f1 = 0; return;                                                           // CLR F1
      case 0xa7: this.psw ^= 0x80; return;                                                      // CPL C
      case 0xb0: case 0xb1: this.burn(1); this.ramW(R(op & 1), this.arg()); return;             // MOV @Rr,#
      case 0xb3: this.burn(1); this.pc = (this.pc & 0xf00) | (this.bus.rom((this.pc & 0xf00) | this.a) & 0xff); return;   // JMPP @A
      case 0xb5: this.f1 ^= 1; return;                                                          // CPL F1
      case 0xb6: this.burn(1); this.cj((this.psw & 0x20) !== 0); return;                        // JF0
      case 0xc5: this.psw &= ~0x10; return;                                                     // SEL RB0
      case 0xc6: this.burn(1); this.cj(this.a === 0); return;                                   // JZ
      case 0xc7: this.a = this.psw | 0x08; return;                                              // MOV A,PSW
      case 0xd0: case 0xd1: this.a ^= this.ramR(R(op & 1)); return;
      case 0xd3: this.burn(1); this.a ^= this.arg(); return;
      case 0xd5: this.psw |= 0x10; return;                                                      // SEL RB1
      case 0xd7: this.psw = this.a & ~0x08; return;                                             // MOV PSW,A
      case 0xe3: this.burn(1); this.a = this.bus.rom(0x300 | this.a) & 0xff; return;            // MOVP3
      case 0xe5: this.a11 = 0x000; return;                                                      // SEL MB0
      case 0xe6: this.burn(1); this.cj(!(this.psw & 0x80)); return;                             // JNC
      case 0xe7: this.a = ((this.a << 1) | (this.a >> 7)) & 0xff; return;                       // RL A
      case 0xf0: case 0xf1: this.a = this.ramR(R(op & 1)); return;                              // MOV A,@Rr
      case 0xf5: this.a11 = 0x800; return;                                                      // SEL MB1
      case 0xf6: this.burn(1); this.cj((this.psw & 0x80) !== 0); return;                        // JC
      case 0xf7: { const c = (this.psw >> 7) & 1; this.psw = (this.psw & 0x7f) | (this.a & 0x80); this.a = ((this.a << 1) | c) & 0xff; return; }   // RLC A
    }
    // JMP / CALL (op & 0x1f == 0x04 / 0x14)
    if ((op & 0x1f) === 0x04) { this.burn(1); const lo8 = this.arg(); this.jmp(((op & 0xe0) << 3) | lo8); return; }
    if ((op & 0x1f) === 0x14) { this.burn(1); const lo8 = this.arg(); this.call(((op & 0xe0) << 3) | lo8); return; }
    // unknown opcode: treat as NOP
  }
}
if (typeof module !== 'undefined') module.exports = { MCS48 }; else window.MCS48 = MCS48;
})();
