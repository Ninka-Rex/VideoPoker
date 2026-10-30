// Game King I/O devices.
'use strict';

// ---------------------------------------------------------------------------
// Philips SC28C94 QUART (quad UART + 2 counter/timers + interrupt arbiter)
// Register index = byte address / 2 (byte lanes 0 and 2 of each 32-bit word).
// Layout as used by the firmware's interrupt handler at 0x080385a8:
//   block A (channels a,b) 0x00-0x0f, block B (channels c,d) 0x10-0x1f
//   per channel: +0 MR, +1 SR/CSR, +2 CR, +3 RxFIFO/TxFIFO  (channels at +0, +8)
//   per block:   +4 IPCR/ACR, +5 ISR/IMR, +6 CTU/CTUR, +7 CTL/CTLR,
//                +0xd IPR/OPCR?, +0xe start C/T, +0xf stop C/T
//   0x28 CIR (current interrupt), 0x2a write = update CIR
// CIR low 5 bits: type<<2 | channel (type 1=input change, 2=Tx, 3=Rx,
// 4=break, 5=counter/timer; counter uses channel 1 for block A, 3 for block B).
// ---------------------------------------------------------------------------
class QUART {
  constructor(machine, base, irqLine, name, clock) {
    this.m = machine; this.start = base; this.end = base + 0x7f;
    this.irqLine = irqLine; this.name = name;
    this.clock = clock || 3686400;
    this.reset();
    this.txOut = [[], [], [], []];
    this.rx = [[], [], [], []];
    this.rxAD = [[], [], [], []];       // multidrop address bit per received byte (reported as SR bit 5)
    this.inputs = [0xff, 0xff];         // IPR per block
  }
  reset() {
    this.w = new Uint8Array(64);         // last written values
    this.imr = [0, 0];
    this.acr = [0, 0];
    this.ctr = [0xffff, 0xffff];         // preload
    this.count = [0xffff, 0xffff];
    this.ctRunning = [false, false];
    this.ctReady = [false, false];
    this.ctAcc = [0, 0];
    this.cir = 0;
    this.ipcr = [0, 0];
    this.txEnabled = [false, false, false, false];
    this.irqState = 0;
  }

  // interrupt sources pending, in priority order: [code, ...]
  pending() {
    const p = [];
    for (let b = 0; b < 2; b++) {
      const imr = this.imr[b];
      if (this.ctReady[b] && (imr & 0x08)) p.push(0x14 | (b ? 3 : 1));
      for (let c = 0; c < 2; c++) {
        const ch = b * 2 + c;
        const sh = c ? 4 : 0;
        if (this.rx[ch].length && (imr & (0x02 << sh))) p.push(0x0c | ch);
        if (this.txEnabled[ch] && (imr & (0x01 << sh))) p.push(0x08 | ch);
      }
      if ((this.ipcr[b] & 0xf0) && (imr & 0x80)) p.push(0x04 | (b ? 2 : 0));
    }
    return p;
  }

  updateIrq() {
    const s = this.pending().length ? 1 : 0;
    if (s !== this.irqState) { this.irqState = s; this.m.cpu.setIrq(this.irqLine, s); }
    else if (s) this.m.cpu.setIrq(this.irqLine, 1);
  }

  read(a) {
    const off = a - this.start;
    if (off & 1) return 0;                       // only byte lanes 0 and 2 are wired
    const reg = ((off >> 2) << 1) | ((off >> 1) & 1);
    const b = reg >> 4, r = reg & 0xf;
    if (reg === 0x0d || reg === 0x1d || reg === 0x1c) {   // input port (IPR) of block A / B
      const blk = reg === 0x0d ? 0 : 1;
      let v = this.inputs[blk];
      if (this.inputHook) v = this.inputHook(blk, v);
      return v;
    }
    if (reg < 0x20) {
      switch (r) {
        case 0x1: case 0x9: {                     // SR
          const ch = b * 2 + (r >> 3);
          return (this.rx[ch].length ? 1 : 0) | 0x0c | (this.rxAD[ch][0] ? 0x20 : 0);   // RxRDY, TxRDY, TxEMT, A/D
        }
        case 0x3: case 0xb: {                     // RxFIFO
          const ch = b * 2 + (r >> 3);
          const v = this.rx[ch].length ? this.rx[ch].shift() : 0; this.rxAD[ch].shift();
          this.updateIrq(); return v;
        }
        case 0x4: { const v = this.ipcr[b] | (this.inputs[b] & 0x0f); this.ipcr[b] &= 0x0f; this.updateIrq(); return v; }
        case 0x5: {                               // ISR
          let v = 0;
          if (this.txEnabled[b * 2]) v |= 0x01;
          if (this.rx[b * 2].length) v |= 0x02;
          if (this.ctReady[b]) v |= 0x08;
          if (this.txEnabled[b * 2 + 1]) v |= 0x10;
          if (this.rx[b * 2 + 1].length) v |= 0x20;
          if (this.ipcr[b] & 0xf0) v |= 0x80;
          return v;
        }
        case 0x6: return (this.count[b] >> 8) & 0xff;
        case 0x7: return this.count[b] & 0xff;
        case 0xe: this.ctRunning[b] = true; this.count[b] = this.ctr[b]; return 0xff;
        case 0xf: this.ctReady[b] = false; this.updateIrq(); return 0xff;
      }
      this.m.note('R ' + this.name, a, reg);
      return 0xff;
    }
    if (reg === 0x28) return this.cir;
    if (reg === 0x1c || reg === 0x1d) {
      let v = this.inputs[reg & 1];
      if (this.inputHook) v = this.inputHook(reg & 1, v);
      return v;
    }
    this.m.note('R ' + this.name, a, reg);
    return 0xff;
  }

  write(a, v) {
    const off = a - this.start;
    if (off & 1) return;
    const reg = ((off >> 2) << 1) | ((off >> 1) & 1);
    const b = reg >> 4, r = reg & 0xf;
    this.w[reg] = v;
    if (reg < 0x20) {
      switch (r) {
        case 0x2: case 0xa: {                     // CR
          const ch = b * 2 + (r >> 3);
          if (v & 0x04) this.txEnabled[ch] = true;
          if (v & 0x08) this.txEnabled[ch] = false;
          this.updateIrq(); return;
        }
        case 0x3: case 0xb: {                     // TxFIFO
          const ch = b * 2 + (r >> 3);
          this.txOut[ch].push(v);
          if (this.onTx) this.onTx(ch, v);
          return;
        }
        case 0x4: this.acr[b] = v; return;
        case 0x5: this.imr[b] = v; this.updateIrq(); return;
        case 0x6: this.ctr[b] = (this.ctr[b] & 0xff) | (v << 8); return;
        case 0x7: this.ctr[b] = (this.ctr[b] & 0xff00) | v; return;
        case 0xe: this.ctRunning[b] = true; this.count[b] = this.ctr[b]; return;
        case 0xf: this.ctReady[b] = false; this.updateIrq(); return;
        case 0xc:                                 // output port register (OP pins are inverted)
          this.oprs = this.oprs || [0, 0]; this.oprs[b] = v;
          if (b === 1) { this.opr = v; if (this.onOutput) this.onOutput(v); }
          return;
      }
      return;
    }
    if (reg === 0x2a) {                           // update CIR
      const p = this.pending();
      this.cir = p.length ? p[0] : 0;
      return;
    }
    this.m.note('W ' + this.name, a, reg + ':' + v);
  }

  // queue bytes to arrive on a channel after `delay` CPU cycles
  // adFirst: the first byte carries the 9th (address / wake-up) bit, as in SAS multidrop framing
  receive(ch, bytes, delay, adFirst) {
    this.rxPending = this.rxPending || [];
    // replies queue behind each other instead of interleaving on the line
    this.rxFree = this.rxFree || [0, 0, 0, 0];
    let t = Math.max((this.m.cpu.ninstr || 0) + (delay || 2000), this.rxFree[ch]);
    bytes.forEach((b, i) => { this.rxPending.push([ch, b, t, adFirst && i === 0 ? 1 : 0]); t += 400; });
    this.rxFree[ch] = t;
  }

  // advance counter/timers
  tick(cpuCycles) {
    if (this.rxPending && this.rxPending.length) {
      const now = this.m.cpu.ninstr;
      let moved = false;
      while (this.rxPending.length && this.rxPending[0][2] <= now) {
        const [ch, b, , ad] = this.rxPending.shift(); this.rx[ch].push(b); this.rxAD[ch].push(ad || 0); moved = true;
      }
      if (moved) this.updateIrq();
    }
    const quartCycles = cpuCycles * this.clock / 24000000;
    for (let b = 0; b < 2; b++) {
      // timer mode (ACR bit 6) always runs; counter mode runs after start command
      const timer = (this.acr[b] & 0x40) !== 0;
      if (!timer && !this.ctRunning[b]) continue;
      const div = ((this.acr[b] >> 4) & 3) === 3 ? 16 : 1;
      this.ctAcc[b] += quartCycles / div;
      const steps = Math.floor(this.ctAcc[b]);
      if (!steps) continue;
      this.ctAcc[b] -= steps;
      const preload = this.ctr[b] || 0x10000;
      let c = this.count[b] - steps;
      if (timer) {
        // square wave: ready on each full period (simplified)
        while (c <= 0) { c += preload; this.ctReady[b] = true; }
      } else {
        while (c < 0) { c += 0x10000; this.ctReady[b] = true; }
      }
      this.count[b] = c & 0xffff;
      if (this.ctReady[b]) this.updateIrq();
    }
  }
}

// ---------------------------------------------------------------------------
// SENET controller (IGT custom, 0x28020000).
//   0x040-0x07c  output latches (lamps / meters), read-modify-written by firmware
//   0x200-0x5fc  buffer RAM
//   0x1fa        I2C data byte
//   0x1fc        I2C control: bit0 GO/busy (cleared by hardware), bit1 STOP,
//                bit2 read transaction; writing low nibble 0 starts a new transfer
// The I2C bus holds a 24C16-style 2KB EEPROM at device address 0xA0 (3 bank bits).
// Protocol taken from the firmware's routines at 0x08077420 (read) and 0x08077590 (write).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Dallas DS2401 silicon serial number on a 1-Wire bus, bit-banged by the firmware
// (routine at 0x081776e0): QUART1 output reg 0x1c bit 6 = 1 drives the wire low,
// input reg 0x1d bit 7 reads the wire. Pulse widths are measured in executed
// instructions: reset ~2900, write-0 ~500, write-1 / read slot ~10.
// ---------------------------------------------------------------------------
class DS2401 {
  constructor(cpu, serial) {
    this.cpu = cpu;
    const rom = [0x01, ...serial];                // family code 0x01 + 48-bit serial
    rom.push(DS2401.crc8(rom));
    this.bits = [];
    for (const b of rom) for (let i = 0; i < 8; i++) this.bits.push((b >> i) & 1);
    this.mode = 'idle'; this.masterLow = false; this.t0 = 0;
    this.presFrom = 0; this.presTo = 0; this.holdTo = 0;
    this.cmd = 0; this.n = 0; this.ptr = 0;
    this.log = [];
  }
  static crc8(bytes) {
    let crc = 0;
    for (let b of bytes) for (let i = 0; i < 8; i++) {
      const mix = (crc ^ b) & 1; crc >>= 1; if (mix) crc ^= 0x8c; b >>= 1;
    }
    return crc;
  }
  drive(low) {
    const now = this.cpu.ninstr;
    if (low && !this.masterLow) {                 // falling edge
      this.t0 = now;
      if (this.mode === 'read') {
        const bit = this.ptr < this.bits.length ? this.bits[this.ptr++] : 1;
        this.holdTo = bit ? 0 : now + 120;
      }
    } else if (!low && this.masterLow) {          // rising edge
      const dur = now - this.t0;
      if (dur > 1500) {
        this.mode = 'cmd'; this.cmd = 0; this.n = 0; this.ptr = 0;
        this.presFrom = now + 20; this.presTo = now + 1200;
      } else if (this.mode === 'cmd') {
        const bit = dur < 100 ? 1 : 0;
        this.cmd |= bit << this.n++;
        if (this.n === 8) {
          this.log.push(this.cmd);
          this.mode = (this.cmd === 0x33 || this.cmd === 0x0f) ? 'read' : 'idle';
        }
      }
    }
    this.masterLow = low;
  }
  lineLow() {
    const now = this.cpu.ninstr;
    if (this.masterLow) return true;
    if (now >= this.presFrom && now < this.presTo) return true;
    if (this.mode === 'read' && now < this.holdTo) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Peripheral bus on QUART2 channel A (multidrop RS-485 style). Host frames:
//   poll:   [addr, 0x00]
//   packet: [addr, type, len, payload..., crc16 lo, crc16 hi]  (len = whole packet)
// CRC is CRC-16/KERMIT. Device 3 is the touch screen (handler at 0x08076ac0).
// ---------------------------------------------------------------------------
function crcKermit(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc & 0xffff;
}
function makePacket(addr, type, payload) {
  const p = [addr, type, payload.length + 5, ...payload];
  const c = crcKermit(p);
  return [...p, c & 0xff, c >> 8];
}

class PeripheralBus {
  constructor(m, quart, ch) {
    this.m = m; this.q = quart; this.ch = ch; this.buf = [];
    this.devices = {};
    this.log = [];
  }
  hostByte(v) {
    const b = this.buf; b.push(v);
    if (b.length === 2 && b[1] === 0x00) { this.frame(b.slice()); b.length = 0; return; }
    if (b.length >= 3 && b.length === b[2]) { this.frame(b.slice()); b.length = 0; return; }
    if (b.length > 260) b.length = 0;       // longest frame: len byte max 0xff
  }
  frame(f) {
    if (this.log.length < 200) this.log.push(f.map(x => x.toString(16).padStart(2, '0')).join(' '));
    const dev = this.devices[f[0]];
    if (!dev) return;
    const reply = f.length === 2 ? dev.poll() : dev.command(f[1], f.slice(3, f.length - 2));
    if (reply) this.q.receive(this.ch, reply, 3000);
  }
}

class TouchScreen {
  constructor(addr) { this.addr = addr; this.queue = []; }
  poll() {
    if (this.queue.length) return this.queue.shift();
    return makePacket(this.addr, 0x00, []);
  }
  command(type, payload) {
    if (type === 0x02) return makePacket(this.addr, 0x02, Array.from('IGT TOUCH 1.0', c => c.charCodeAt(0)));
    if (type === 0x30) return makePacket(this.addr, 0x30, [0, 0, 0]);       // no diagnostic errors
    return makePacket(this.addr, 0x00, []);
  }
  // event: 1 = down, 2 = drag, 3 = lift; x 12-bit, y 16-bit
  touch(event, x, y) {
    this.queue.push(makePacket(this.addr, 0x10, [(event << 4) | ((x >> 8) & 0xf), x & 0xff, (y >> 8) & 0xff, y & 0xff]));
  }
}

// Netplex device 4: bill validator (Triple-Five Play expects one; without it: "Bill Validator Comm Failure").
// Worked out from the driver at 0x08004330 (state in 0x10003afc, per-state handlers in the table at 0x080043a8).
// Command types use the low 6 bits; the top 2 bits are a sequence counter.
//  - Every command is answered straight away. 0x01 means "repeat your last answer" (the host only sends it
//    when an answer went missing).
//  - 0x22 signature request (seed in payload bytes 4-5) -> type 0x23 + 16-bit value;
//    0x02 version request -> type 0x02 (empty = matches what the game expects); anything else -> type 0x01.
//  - Bills: in the idle state (15) the validator reports type 0x30 with the value in cents (24-bit, little
//    endian) and a country byte at packet offset 14 (0 = no scaling). The host checks it against its list
//    of accepted values, then orders "stack" (0x32), answered with 0x31 = stacked, which credits the player;
//    or "return" (0x33), answered with 0x33 = returned.
class BillValidator {
  constructor(addr) { this.addr = addr; this.queue = []; this.last = null; this.escrow = 0; this.seen = []; this.onBill = null; }
  poll() { return this.queue.length ? this.queue.shift() : makePacket(this.addr, 0x00, []); }
  command(type, payload) {
    if (this.seen.length < 64) this.seen.push(type);
    if (type === 0x01) return this.last || makePacket(this.addr, 0x01, []);
    let r;
    switch (type & 0x3f) {
      case 0x22: r = makePacket(this.addr, 0x23, [payload[4] || 0, payload[5] || 0]); break;
      case 0x02: r = makePacket(this.addr, 0x02, []); break;
      case 0x32:
        if (this.escrow) { r = makePacket(this.addr, 0x31, []); this.stacked = (this.stacked || 0) + 1; if (this.onBill) this.onBill('stacked', this.escrow); this.escrow = 0; }
        else r = makePacket(this.addr, 0x01, []);
        break;
      case 0x33:
        if (this.escrow) { r = makePacket(this.addr, 0x33, []); this.returned = (this.returned || 0) + 1; if (this.onBill) this.onBill('returned', this.escrow); this.escrow = 0; }
        else r = makePacket(this.addr, 0x01, []);
        break;
      default: r = makePacket(this.addr, 0x01, []);
    }
    this.last = r;
    return r;
  }
  // a voucher: type 0x3a, payload 0 + the barcode digits (decoded in pairs at 0x080040f0). Whether it is
  // paid is up to the game (and its SAS host): it answers with stack (0x32) or return (0x33) as for bills.
  info() {
    const h = t => (t & 0x3f).toString(16);
    return [['bill validator', 'netplex 4 · ' + (this.escrow ? 'escrow: ' + this.escrow : 'idle')],
      ['validator commands', this.seen.slice(-8).map(h).join(' ') || '–'],
      ['bills / vouchers', (this.stacked || 0) + ' stacked · ' + (this.returned || 0) + ' returned']];
  }
  insertTicket(barcode) {
    const digits = String(barcode).replace(/[^0-9]/g, '');
    if (this.escrow || digits.length < 2 || digits.length % 2) return false;
    this.escrow = 'ticket ' + digits;
    this.queue.push(makePacket(this.addr, 0x3a, [0, ...Array.from(digits, c => c.charCodeAt(0))]));
    return true;
  }
  // value in cents (e.g. 10000 = $100); returns false while another bill is still in escrow
  insertBill(cents) {
    if (this.escrow) return false;
    this.escrow = cents;
    const p = new Array(12).fill(0);
    p[0] = cents & 0xff; p[1] = (cents >> 8) & 0xff; p[2] = (cents >> 16) & 0xff;
    this.queue.push(makePacket(this.addr, 0x30, p));
    return true;
  }
}

// Netplex device 2: thermal ticket printer (FutureLogic-style TCL commands inside Netplex packets).
// Worked out from the driver at 0x0807a8d0 (reply handler) / 0x0807b020 (job sender) of g0001783:
//  - 0x30 carries TCL text: "^b|0|^^l|Ic|^" at power-up, "^P|<template>|<copies>|<field>|...|^" to print,
//    "^C|^", "^C|j|^" to clear errors. Answered with type 0x11 (chunk ack, payload [0]).
//  - The printer identifies itself with an unsolicited type-0x30 message (needs the host's 0x01 ack):
//    the ':' must sit at packet byte 13 or later, the next character picks the job timeout (' ' = 4.5 s)
//    and the rest must match the firmware's expected id ("012345678").
//  - 0x12 asks for status: "*S|<unit>|<version>|f1|f2|f3|f4|f5|*", five flag characters (0x40 + bits),
//    each followed by '|'. f1: 0x04 paper out, 0x08 platen up, 0x10 system error; f3: 0x20 command error,
//    0x01 wrong paper; f5: 0x10 top of form (a job finished), 0x20 barcode printed.
//  - After a ticket the printer pushes a status with "top of form" so the job completes in time.
// Frames can be up to 255 bytes (a cash-out ticket is about 225).
class NetplexPrinter {
  constructor(addr) {
    this.addr = addr; this.queue = []; this.last = null; this.seen = [];
    this.tickets = 0; this.lastText = ''; this.onTicket = null; this.paperOut = false;
    this.printPolls = 20;   // polls (about 20 ms each) before the printer reports the ticket done
    this.hooks = [];        // internal listeners (e.g. the SAS host learns each voucher)
  }
  status(f5) {
    const f1 = String.fromCharCode(0x40 | (this.paperOut ? 0x04 : 0));
    return makePacket(this.addr, 0x12, Array.from('*S|0|IGT01|' + f1 + '|@|@|@|' + (f5 || '@') + '|*', c => c.charCodeAt(0)));
  }
  poll() {
    // delayed reports (a ticket takes a moment to print)
    if (this.later && this.later.length && --this.later[0][0] <= 0) this.queue.push(this.later.shift()[1]);
    return this.queue.length ? this.queue.shift() : makePacket(this.addr, 0x00, []);
  }
  command(type, payload) {
    if (this.seen.length < 64) this.seen.push(type);
    if (type === 0x01) return this.last || makePacket(this.addr, 0x01, []);
    const k = type & 0x3f;
    let r;
    if (k === 0x30) {
      const text = String.fromCharCode(...payload);
      if (text.includes('^b|')) this.queue.push(makePacket(this.addr, 0x30, Array.from('IGTPRINTER: 012345678', c => c.charCodeAt(0))));
      for (const m of text.matchAll(/\^P\|([^^]*)\^/g)) this.print(m[1].split('|'));
      r = makePacket(this.addr, 0x11, [0]);
    } else if (k === 0x12) r = this.status();
    else r = makePacket(this.addr, 0x01, []);
    this.last = r;
    return r;
  }
  // fields of a ^P command: template, copies, then template fields
  print(f) {
    const [template, copies, ...v] = f;
    this.tickets++;
    const text = NetplexPrinter.render(template, v);
    this.lastText = text;
    const info = { template: +template, copies: +copies, fields: v };
    for (const h of this.hooks) h(text, info);
    if (this.onTicket) this.onTicket(text, info);
    // report the finished job (top of form), then back to idle
    this.later = (this.later || []).concat([[this.printPolls, this.status(String.fromCharCode(0x40 | 0x10))], [1, this.status()]]);
  }
  // Text layout of the IGT voucher templates (field order taken from the ^P data the game sends).
  static render(template, v) {
    const g = i => (v[i] || '').trim();
    const c = s => { s = String(s); const pad = Math.max(0, Math.floor((40 - s.length) / 2)); return ' '.repeat(pad) + s; };
    if (+template === 0 || +template === 1) {
      // 0: cash-out voucher, 1: jackpot / handpay receipt. Fields: validation, establishment, location,
      // city, -, -, validation, date, time, ticket #, amount in words, -, amount, -, expiry, machine #, barcode
      return [c(g(1)), c(g(2)), c(g(3)), '', c(+template === 0 ? 'CASHOUT TICKET' : 'JACKPOT TICKET'), '',
        c('VALIDATION ' + g(0)), '', c(g(7) + '   ' + g(8) + '   ' + g(9)), '',
        c(g(12)), c(g(10)), '', c('Ticket void after ' + (g(14) || '30 days')), c(g(15)), '',
        c('|| ' + g(16) + ' ||'), c('Barcode: ' + g(16))].join('\n');
    }
    return 'TEMPLATE ' + template + '\n' + v.map((x, i) => i + ': ' + x).join('\n');
  }
  info() {
    return [['ticket printer', 'netplex ' + this.addr + (this.paperOut ? ' · PAPER OUT' : ' · ready') + ' · ' + this.tickets + ' printed'],
      ['printer commands', this.seen.slice(-8).map(t => (t & 0x3f).toString(16)).join(' ') || '–']];
  }
  // the 18-digit barcode of a rendered ticket (for feeding it back into the bill validator)
  static barcodeFrom(text) { const m = /(\d{18})/.exec(String(text).replace(/-/g, '')); return m ? m[1] : null; }
}

class SENET {
  constructor(m) {
    this.m = m; this.start = 0x28020000; this.end = 0x2802ffff;
    this.mem = new Uint8Array(0x10000);
    // regs 0x28..0x32. Idle state: buttons released (0), sensors at rest.
    //   0x28 b0-b4 hold 1-5, b5 language, b6 deal/draw, b7 cashout (buttons active high)
    //   0x2a b0 bet max, b1 bet one, b2/b3 coin optics A/B (1 = clear), b4 coin valid pulse
    //   0x32 b1 meter connected
    this.inputs = new Uint8Array([0x00, 0x0c, 0x00, 0x00, 0x00, 0x02]);
    this.eeprom = new Uint8Array(2048).fill(0xff);
    this.state = 'idle'; this.bank = 0; this.addr = 0;
    this.eepromDirty = false;
  }
  // Hopper: while the motor runs a coin interrupts the coin-out optic for 50 ms about every 100 ms
  // (first coin after 150 ms). The firmware jams the hopper if no coin follows within 750 ms.
  hopperNow() { return this.m.frame * this.m.LINES + (this.m.line || 0); }
  hopperOptic() {
    if (!this.hopperOn) return false;
    const L = this.m.LINES, t = this.hopperNow() - this.hopperStart - 9 * L;
    return t >= 0 && (t % (6 * L)) < 3 * L;
  }
  read(a) {
    const o = a & 0xffff;
    if (o >= 0x28 && o <= 0x33 && !(o & 1)) {          // switch input registers
      // 0x30 bit 5 is the hopper coin-out optic (routine 0x0805c480/0x0805c8c0); idle = 0
      if (o === 0x30) { const op = this.hopperOptic(); if (op && !this.lastOptic) this.m.coinsOut = (this.m.coinsOut || 0) + 1; this.lastOptic = op; return this.inputs[4] | (op ? 0x20 : 0); }
      return this.inputs[(o - 0x28) >> 1];
    }
    return this.mem[o];
  }
  write(a, v) {
    const o = a & 0xffff;
    if (o === 0x1fc) return this.ctrl(v);
    if (o === 0x70) {                 // hopper motor: bit 1 on = paying coins out (see 0x0805d1c8)
      const on = (v & 2) !== 0;
      if (on && !this.hopperOn) this.hopperStart = this.hopperNow();
      this.hopperOn = on;
    }
    this.mem[o] = v;
  }
  ctrl(v) {
    if ((v & 0x0f) === 0) this.state = 'idle';
    if (v & 1) {
      const data = this.mem[0x1fa];
      const readMode = (v & 4) !== 0;
      switch (this.state) {
        case 'idle':
          this.bank = (data >> 1) & 7; this.state = 'addr'; break;
        case 'addr':
          this.addr = (this.bank << 8) | data; this.state = readMode ? 'rdevsel' : 'wdata'; break;
        case 'rdevsel':
          this.state = 'rdata'; break;
        case 'rdata':
          this.mem[0x1fa] = this.eeprom[this.addr]; this.addr = (this.addr + 1) & 0x7ff; break;
        case 'wdata':
          this.eeprom[this.addr] = data; this.eepromDirty = true;
          this.addr = (this.addr & ~0xf) | ((this.addr + 1) & 0xf); break;
      }
      if (v & 2) this.state = 'idle';
    }
    this.mem[0x1fc] = v & ~3;        // operation completes immediately
  }
}

// ---------------------------------------------------------------------------
// Yamaha YMZ280B PCMD8 (port of MAME src/devices/sound/ymz280b.cpp).
// 8 voices; ADPCM / PCM8 / PCM16 from the SND ROMs. 0x28050000 = register select,
// 0x28050002 = data / status. Voice rate = 16.9344 MHz / 384 * 2 * (fnum + 1) / 512.
// ---------------------------------------------------------------------------
const YMZ_INDEX_SCALE = [0x0e6, 0x0e6, 0x0e6, 0x0e6, 0x133, 0x199, 0x200, 0x266];
const YMZ_DIFF = Array.from({ length: 16 }, (_, n) => ((n & 7) * 2 + 1) * ((n & 8) ? -1 : 1));

class YMZ280B {
  constructor(m, rom) {
    this.m = m; this.rom = rom; this.start = 0x28050000; this.end = 0x28050003;
    this.outRate = 44100;
    this.reset();
  }
  reset() {
    this.reg = 0; this.status = 0; this.keyonEnable = 0; this.irqMask = 0; this.irqEnable = 0;
    this.v = [];
    for (let i = 0; i < 8; i++) this.v.push({ fnum: 0, looping: 0, mode: 0, keyon: 0, level: 0, pan: 8,
      start: 0, loopStart: 0, loopEnd: 0, stop: 0, playing: 0, position: 0, signal: 0, step: 0x7f,
      loopSignal: 0, loopStep: 0x7f, loopCount: 0, frac: 1, prev: 0, curr: 0, ended: false });
  }
  romByte(a) { return this.rom[a & (this.rom.length - 1)]; }
  read(a) {
    if (a & 2) { const s = this.status; this.status = 0; return s; }   // status (clears)
    return 0xff;
  }
  write(a, d) {
    if (!(a & 2)) { this.reg = d; return; }
    const r = this.reg;
    if (r < 0x80) {
      const v = this.v[(r >> 2) & 7];
      switch (r & 0xe3) {
        case 0x00: v.fnum = (v.fnum & 0x100) | d; break;
        case 0x01:
          v.fnum = (v.fnum & 0xff) | ((d & 1) << 8);
          v.looping = (d >> 4) & 1;
          if ((d & 0x60) === 0) d &= 0x7f; else v.mode = (d >> 5) & 3;
          if (!v.keyon && (d & 0x80) && this.keyonEnable) {
            v.playing = 1; v.position = v.start; v.signal = v.loopSignal = 0; v.step = v.loopStep = 0x7f; v.loopCount = 0;
          } else if (v.keyon && !(d & 0x80)) v.playing = 0;
          v.keyon = (d >> 7) & 1;
          break;
        case 0x02: v.level = d; break;
        case 0x03: v.pan = d & 0x0f; break;
        case 0x20: v.start = (v.start & 0x1fffe) | (d << 17); break;
        case 0x21: v.loopStart = (v.loopStart & 0x1fffe) | (d << 17); break;
        case 0x22: v.loopEnd = (v.loopEnd & 0x1fffe) | (d << 17); break;
        case 0x23: v.stop = (v.stop & 0x1fffe) | (d << 17); break;
        case 0x40: v.start = (v.start & 0x1fe01fe) | (d << 9); break;
        case 0x41: v.loopStart = (v.loopStart & 0x1fe01fe) | (d << 9); break;
        case 0x42: v.loopEnd = (v.loopEnd & 0x1fe01fe) | (d << 9); break;
        case 0x43: v.stop = (v.stop & 0x1fe01fe) | (d << 9); break;
        case 0x60: v.start = (v.start & 0x1fffe00) | (d << 1); break;
        case 0x61: v.loopStart = (v.loopStart & 0x1fffe00) | (d << 1); break;
        case 0x62: v.loopEnd = (v.loopEnd & 0x1fffe00) | (d << 1); break;
        case 0x63: v.stop = (v.stop & 0x1fffe00) | (d << 1); break;
      }
      return;
    }
    if (r === 0xfe) { this.irqMask = d; return; }
    if (r === 0xff) {
      this.irqEnable = (d >> 4) & 1;
      if (this.keyonEnable && !(d & 0x80)) for (const v of this.v) v.playing = 0;
      else if (!this.keyonEnable && (d & 0x80)) for (const v of this.v) if (v.keyon && v.looping) v.playing = 1;
      this.keyonEnable = (d >> 7) & 1;
    }
  }
  // decode one source sample for a voice; returns null when the sample ends
  nextSample(v) {
    let out;
    if (v.mode === 1) {                                        // 4-bit ADPCM
      const val = this.romByte(v.position >> 1) >> ((~v.position & 1) << 2);
      v.signal += Math.trunc(v.step * YMZ_DIFF[val & 15] / 8);
      if (v.signal > 32767) v.signal = 32767; else if (v.signal < -32768) v.signal = -32768;
      v.step = (v.step * YMZ_INDEX_SCALE[val & 7]) >> 8;
      if (v.step > 0x6000) v.step = 0x6000; else if (v.step < 0x7f) v.step = 0x7f;
      out = v.signal;
      v.position++;
      if (v.looping) {
        if (v.position === v.loopStart && v.loopCount === 0) { v.loopSignal = v.signal; v.loopStep = v.step; }
        if (v.position >= v.loopEnd && v.keyon) { v.position = v.loopStart; v.signal = v.loopSignal; v.step = v.loopStep; v.loopCount++; }
      }
    } else if (v.mode === 2) {                                 // 8-bit PCM
      out = ((this.romByte(v.position >> 1) << 24) >> 24) * 256;
      v.position += 2;
      if (v.looping && v.position >= v.loopEnd && v.keyon) v.position = v.loopStart;
    } else if (v.mode === 3) {                                 // 16-bit PCM
      out = (((this.romByte((v.position >> 1) + 1) << 8) | this.romByte(v.position >> 1)) << 16) >> 16;
      v.position += 4;
      if (v.looping && v.position >= v.loopEnd && v.keyon) v.position = v.loopStart;
    } else return null;
    if (v.position >= v.stop) v.ended = true;
    return out;
  }
  // mix `n` stereo samples at outRate into L/R (Float32Arrays), starting at offset
  render(L, R, off, n) {
    const srcPerOut = 88200 / this.outRate / 512;            // source samples per output sample per (fnum+1)
    for (let i = 0; i < 8; i++) {
      const v = this.v[i];
      if (!v.playing && v.prev === 0 && v.curr === 0) { v.frac = 1; continue; }
      const step = ((v.mode === 1 ? (v.fnum & 0xff) : v.fnum) + 1) * srcPerOut;
      let lv, rv;
      if (v.pan === 8) lv = rv = v.level;
      else if (v.pan < 8) { lv = v.level; rv = v.pan === 0 ? 0 : v.level * (v.pan - 1) / 7; }
      else { lv = v.level * (15 - v.pan) / 7; rv = v.level; }
      lv /= 255 * 32768 * 2.5; rv /= 255 * 32768 * 2.5;
      for (let k = 0; k < n; k++) {
        while (v.frac >= 1) {
          v.frac -= 1;
          v.prev = v.curr;
          let s = v.playing ? this.nextSample(v) : null;
          if (s === null || v.ended) {
            if (v.ended && s !== null) v.curr = s;
            if (v.playing) { v.playing = 0; this.status |= 1 << i; }
            v.ended = false;
            s = (v.curr * 15) >> 4;                                // ramp to silence
          }
          v.curr = s;
        }
        const x = v.prev + (v.curr - v.prev) * v.frac;
        L[off + k] += x * lv; R[off + k] += x * rv;
        v.frac += step;
      }
    }
  }
}

function installDevices(m) {
  m.quart1 = m.addDevice(new QUART(m, 0x28010000, 3, 'Q1'));
  m.quart2 = m.addDevice(new QUART(m, 0x28040000, 0, 'Q2'));
  m.diag = '';
  m.quart1.onTx = (ch, v) => { if (ch === 3) m.diag += String.fromCharCode(v); };
  m.bus = new PeripheralBus(m, m.quart2, 0);
  m.touch = m.bus.devices[3] = new TouchScreen(3);
  // Netplex / SAS peripherals. Can also be attached later (the provisioning script sets a machine up
  // without them, then attaches them for the ticket-in / ticket-out options).
  m.attachPeripherals = p => {
    if (p.billValidator && !m.bv) m.bv = m.bus.devices[4] = new BillValidator(4);
    if (p.printer && !m.printer) m.printer = m.bus.devices[2] = new NetplexPrinter(2);
    // SAS host on QUART1 channel 1 (ticket in needs the host's approval); printed vouchers are registered with it
    if (p.sas && !m.sas) {
      const SH = (typeof require !== 'undefined') ? require('./sashost.js').SASHost : window.SASHost;
      m.sas = new SH(m.quart1, 1, 1);
      let lastFrame = -1;
      m.addDevice({ start: 1, end: 0, tick() { if (m.frame !== lastFrame) { lastFrame = m.frame; m.sas.tick(); } } });
      if (m.printer) m.printer.hooks.push((text, info) => { const v = info.fields; m.sas.register(v[0], Math.round(parseFloat(String(v[12] || '0').replace(/[^0-9.]/g, '')) * 100)); });
    }
  };
  m.attachPeripherals({ billValidator: (m.opts && m.opts.billValidator) || (m.roms && m.roms.billValidator),
    printer: m.roms && m.roms.printer, sas: m.roms && m.roms.sas });
  m.quart2.onTx = (ch, v) => { if (ch === 0) m.bus.hostByte(v); };
  // QUART2 input port B (reg 0x1d @ 0x2804003a):
  //   bits 0-2 door switches: main, coin drop, bill validator. A closed door echoes the
  //   strobe the firmware toggles on QUART2 port A output bit 1 (see 0x080441f0); an
  //   open door does not. bit3 logic board lock, bit4 attendant key, bit5 test (active low).
  m.quart2.inputs = [0xff, 0xff];
  m.doorOpen = { mainDoor: false, door2: false, door3: false };
  m.quart2.inputHook = (blk, v) => {
    if (blk !== 1) return v;
    const op = (m.quart2.oprs ? m.quart2.oprs[0] : 0);
    const echo = ((~op) >> 1) & 1;                    // OP1 pin level
    let d = 0;
    ['mainDoor', 'door2', 'door3'].forEach((n, i) => { d |= (m.doorOpen[n] ? echo ^ 1 : echo) << i; });
    return (v & ~7) | d;
  };
  m.switches = {
    key: [m.quart2, 1, 0x10, false],     // [device, port, mask, activeHigh]
    test: [m.quart2, 1, 0x20, false],
  };
  m.setSwitch = (name, on) => {
    if (name in m.doorOpen) { m.doorOpen[name] = on; return; }
    const [dev, port, mask, activeHigh] = m.switches[name];
    const bitSet = activeHigh ? on : !on;
    dev.inputs[port] = bitSet ? (dev.inputs[port] | mask) : (dev.inputs[port] & ~mask);
  };
  m.senet = m.addDevice(new SENET(m));
  // Sound: the firmware drives a YM2413 FM chip at 0x28050000 (register protocol
  // confirmed from its writes). The YMZ280B sample player belongs to the optional
  // Multimedia sound board; it is mapped at 0x28000000 but not used by this set.
  const OPLLImpl = (typeof require !== 'undefined') ? require('./opll.js').OPLL : window.OPLL;
  m.opll = new OPLLImpl(44100);
  m.addDevice({ start: 0x28050000, end: 0x28050003, read: a => m.opll.read(a), write: (a, v) => m.opll.write(a, v) });
  m.ymz = m.addDevice(new YMZ280B(m, m.snd.u8));
  m.ymz.start = 0x28000000; m.ymz.end = 0x28000003;
  // audio: 735 stereo samples per 60 Hz frame at 44.1 kHz
  m.audioL = new Float32Array(735); m.audioR = new Float32Array(735);
  const runFrame = m.runFrame.bind(m);
  m.runFrame = () => {
    runFrame();
    m.audioL.fill(0); m.audioR.fill(0);
    m.opll.render(m.audioL, m.audioR, 0, 735);
    m.ymz.render(m.audioL, m.audioR, 0, 735);
    if (m.onAudio) m.onAudio(m.audioL, m.audioR);
  };
  // Coin acceptor: valid-coin pulse (0x2a bit4), then optic A (bit2) and optic B (bit3)
  // blocked/cleared in sequence (firmware state machine at 0x0817c1f0). Steps run per frame.
  // debug panel: sections of [label, value] rows; a row [title] starts a section
  m.coinsIn = 0;
  m.debugInfo = () => {
    const hex = (v, n) => (v >>> 0).toString(16).toUpperCase().padStart(n || 2, '0');
    const rows = [['System'],
      ['architecture', 'Intel i960 (32-bit RISC) · memory-mapped I/O'],
      ['memory', (m.NV_SIZE / 1024) + ' KB battery-backed RAM · 2 KB serial EEPROM · base + game + graphics ROMs'],
      ['video', 'custom tile/sprite graphics from CG ROMs, 640×480'],
      ['io', 'QUART serial controllers: touch screen, bill validator, ticket printer, SAS host (Netplex bus)'],
      ['running', Math.round(m.frame / 60) + ' s emulated']];
    rows.push(['Sound'], ['ym2413', 'channels keyed ' + Array.from(m.opll.keyOn).filter(Boolean).length + '/9 · rhythm ' + hex(m.opll.rhythmKeys)]);
    rows.push(['ymz280b', m.ymz.v.filter(v => v && v.playing).length + ' voices playing']);
    rows.push(['Coins'], ['coin acceptor', m.coinsIn + ' inserted · ' + (m.coinsOut || 0) + ' paid out'],
      ['hopper', m.senet.hopperOn ? 'motor running' : 'idle']);
    if (m.bv) rows.push(['Bill validator'], ...m.bv.info());
    if (m.printer) rows.push(['Printer'], ...m.printer.info());
    if (m.sas) rows.push(['SAS host'], ...m.sas.info());
    return rows;
  };
  m.coinSteps = [];
  m.insertCoin = () => {
    m.coinsIn++;
    const r = m.senet.inputs;
    m.coinSteps.push(() => r[1] |= 0x10, () => r[1] &= ~0x10, () => r[1] &= ~0x04, () => {}, () => r[1] &= ~0x08,
                     () => r[1] |= 0x04, () => {}, () => r[1] |= 0x08, () => {});
  };
  m.addDevice({ start: 1, end: 0, tick() {
    if (m.coinSteps.length && m.line === 0) m.coinSteps.shift()();
  } });
  // DS2401 serial number on QUART1's output port / input bit 7
  m.ds2401 = new DS2401(m.cpu, [0x60, 0x19, 0x96, 0x42, 0x00, 0x00]);
  m.quart1.onOutput = v => m.ds2401.drive((v & 0x40) !== 0);
  m.quart1.inputHook = (port, v) => {
    if (port === 1) return (v & 0x7f) | (m.ds2401.lineLow() ? 0 : 0x80);   // 1-wire serial number
    // block A bit 2: AC line zero-cross signal, 60 Hz square wave (firmware routine 0x0817c4a0)
    const t = m.frame * m.LINES + m.line;
    return (v & ~0x04) | ((Math.floor(t / (m.LINES / 2)) & 1) << 2);
  };
}

if (typeof module !== 'undefined') module.exports = installDevices;
else window.installDevices = installDevices;
