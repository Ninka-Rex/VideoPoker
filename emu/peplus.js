// IGT Player's Edge / Player's Edge Plus (80C32 + 6545 CRTC + AY-3-8912 + X2404P EEPROM).
// Memory map, inputs and the door/coin/bill-validator behaviour follow MAME's peplus.cpp,
// then were checked against the firmware.
'use strict';
(function () {
const MC = (typeof require !== 'undefined') ? require('./mcs51.js').MCS51 : window.MCS51;
const AY = (typeof require !== 'undefined') ? require('./ay8910.js').AY8910 : window.AY8910;
const IM = (typeof require !== 'undefined') ? require('./i2cmem.js').I2CMem : window.I2CMem;
const BV = (typeof require !== 'undefined') ? require('./pebill.js').PEBillValidator : window.PEBillValidator;

const CYCLES_PER_SEC = 10000000 / 12;
const FRAME_CYCLES = CYCLES_PER_SEC / 60;
const LINES = 256;

// input bits per game family: bank1 (IN_BANK1) and bank2 (IN_BANK2)
const KEYS = {
  jackpot: [1, 0x01], test: [1, 0x02],
  hold1: [1, 0x04], hold2: [1, 0x08], hold3: [1, 0x10], hold4: [1, 0x20], hold5: [1, 0x40],
  deal: [2, 0x01], maxbet: [2, 0x02], playcredit: [2, 0x08], cashout: [2, 0x10], change: [2, 0x20], bill: [2, 0x40],
};

class PEPlus {
  // roms: { prog: Uint8Array (32K or 64K), cg: [r,g,b,x], prom: Uint8Array(256), plus: bool, sw1: byte }
  constructor(roms, opts) {
    opts = opts || {};
    this.roms = roms;
    this.sw1 = roms.sw1 !== undefined ? roms.sw1 : 0xff;
    this.doorCycle = roms.plus !== false;
    this.doorWait = 500;
    this.coinStep = 10000;            // cycles per coin-optic step (A, AB, ABC, BC, C)
    this.coinPulse = false;           // single-pulse coin mode (only seen while the drop door reads as open)
    this.dropDoorClosed = true;
    this.rate = 44100;
    this.code = new Uint8Array(65536);
    if (roms.prog.length >= 0x10000) this.code.set(roms.prog.subarray(0, 0x10000));
    else { this.code.set(roms.prog, 0); this.code.set(roms.prog, 0x8000); }
    this.cmos = new Uint8Array(0x2000);
    this.ram = {};
    for (const a of [0x3000, 0x5000, 0x7000, 0xb000, 0xd000, 0xf000]) this.ram[a] = new Uint8Array(0x1000);
    // Superboard: the X-series data ROM (u66) is copied into these RAM windows at power-on
    if (roms.superData) for (const a in this.ram) this.ram[a].set(roms.superData.subarray(+a, +a + 0x1000));
    this.eeprom = new IM(0x100, 8, 0x200);
    this.decodeTiles();
    this.buildPalette();
    this.cpu = new MC({
      code: this.code,
      xread: a => this.xread(a), xwrite: (a, v) => this.xwrite(a, v),
      portOut: (n, v) => { if (n === 1) this.paldata[0] = v; else if (n === 3) this.paldata[1] = v; },
      serialTx: v => { if (this.onSerial) this.onSerial(v); },
    });
    this.ay = new AY(10000000 / 6, this.rate);
    this.keys = { 1: 0, 2: 0 };
    this.doorUpperClosed = true; this.cardCage = 0;
    this.sensor = 0;
    this.reset(true);
  }

  reset(first) {
    this.cpu.reset();
    this.videoram = new Uint8Array(0x400);
    this.pal = [new Uint8Array(0x400), new Uint8Array(0x400)];
    this.paldata = [0, 0];
    this.crtc = { addr: 0, regs: new Uint8Array(32), update: 0, ready: true, vsync: false, lpen: false };
    this.vid = 0;
    this.duart = { imr: 0, rxB: [], pending: [], txCount: 0 };
    // progressive link: levels in cents (top level last); only MG multi-game programs use it
    this.link = /^mg/i.test(this.roms.name || '') ? { amounts: (this.link && this.link.amounts) || [104235, 78810, 61255, 25480], level: 0, buf: [], next: 0 } : null;
    this.frame = 0; this.line = 0;
    this.lastCycles = 0; this.coinState = 0; this.lastDoor = 0; this.doorOpen = 0;
    this.lastDrop = 0; this.dropLevel = 0;
    this.lastCoinOut = 0; this.coinOutState = 0; this.sdaDir = 0;
    // bill validator: Montana's own pulse-count protocol, MAME's ID-022 for the others
    this.bv = new BV(CYCLES_PER_SEC / 1000, /^mg/i.test(this.roms.name || '') ? 'count' : 'id022');
    this.bgcolor = 0;
    this.setBg(0);
    this.audioRem = 0;
    this.outA = 0; this.outB = 0; this.outC = 0;
    this.soundEvents = 0;
  }

  // ---------- graphics ----------
  decodeTiles() {
    const cg = this.roms.cg;
    const n = 0x8000 / 8;
    this.tiles = new Uint8Array(n * 64 * 2);       // up to 8192 tiles (second half for 64K sets)
    const planes = 4;
    for (let t = 0; t < n; t++) {
      for (let y = 0; y < 8; y++) {
        const b = [cg[0][t * 8 + y] | 0, cg[1][t * 8 + y] | 0, cg[2][t * 8 + y] | 0, cg[3][t * 8 + y] | 0];
        for (let x = 0; x < 8; x++) {
          const s = 7 - x;
          this.tiles[t * 64 + y * 8 + x] = (((b[3] >> s) & 1) << 3) | (((b[2] >> s) & 1) << 2) | (((b[1] >> s) & 1) << 1) | ((b[0] >> s) & 1);
        }
      }
    }
    void planes;
  }
  buildPalette() {
    const prom = this.roms.prom, n = 512;
    this.palette = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const d = ~prom[i % prom.length] & 0xff;
      const r = 0x21 * ((d >> 2) & 1) + 0x47 * ((d >> 1) & 1) + 0x97 * (d & 1);
      const g = 0x21 * ((d >> 5) & 1) + 0x47 * ((d >> 4) & 1) + 0x97 * ((d >> 3) & 1);
      const b = 0x47 * ((d >> 7) & 1) + 0x97 * ((d >> 6) & 1);
      this.palette[i] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
  }
  setBg(data) {
    this.bgcolor = data;
    const d = ~data & 0xff;
    const r = 0x21 * ((d >> 2) & 1) + 0x47 * ((d >> 1) & 1) + 0x97 * (d & 1);
    const g = 0x21 * ((d >> 5) & 1) + 0x47 * ((d >> 4) & 1) + 0x97 * ((d >> 3) & 1);
    const b = 0x47 * ((d >> 7) & 1) + 0x97 * ((d >> 6) & 1);
    this.bgRGB = [r, g, b];
    for (let i = 0; i < 32; i++) this.palette[15 + i * 16] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  render(px) {
    for (let row = 0; row < 25; row++) for (let col = 0; col < 40; col++) {
      const i = row * 40 + col;
      const pr = this.pal[0][i], pr2 = this.pal[1][i];
      let code = ((pr & 0x0f) << 8) | this.videoram[i], color = (pr >> 4) & 0x0f;
      if (this.roms.cg64 && (pr2 & 0x10)) { code += 0x1000; color += 0x10; }
      const tb = code * 64, pb = color * 16;
      for (let y = 0; y < 8; y++) {
        const o = (row * 8 + y) * 320 + col * 8;
        for (let x = 0; x < 8; x++) px[o + x] = this.palette[pb + this.tiles[tb + y * 8 + x]];
      }
    }
  }

  // ---------- bus ----------
  xread(a) {
    if (a < 0x2000) return this.cmos[a];
    // the I/O latches decode only the top address bits: some programs address them at 0x802A, 0xC02A ...
    if (a >= 0x8000 && a < 0xd000 && (a & 0xf000) !== 0xb000) a &= 0xf000;
    switch (a) {
      case 0x2080: return this.crtcStatus();
      case 0x2081: return this.crtcRegR();
      case 0x2083: return this.crtcRegR();
      case 0x4004: return this.sw1;
      case 0x6000: return this.bgRGB[2];        // MAME returns the low byte of the packed colour (blue)
      case 0x8000: return this.inputBankA();
      case 0x9000: return this.dropDoorRead();
      case 0xa000: return this.input0();
      case 0xc000: return 0;
    }
    if (a >= 0xe000 && a < 0xe010) return this.duartRead(a & 15);
    const base = a & 0xf000;
    if (this.ram[base] && a >= 0x3000) return this.ram[base][a & 0xfff];
    return 0xff;
  }
  xwrite(a, v) {
    v &= 0xff;
    if (a < 0x2000) { this.cmos[a] = v; return; }
    if (a >= 0x8000 && a < 0xd000 && (a & 0xf000) !== 0xb000) a &= 0xf000;
    switch (a) {
      case 0x2008: return;
      case 0x2080: this.crtc.addr = v & 0x1f; return;
      case 0x2081: this.crtcRegW(v); return;
      case 0x2083: {
        const i = this.vid & 0x3ff;
        this.videoram[i] = v; this.pal[0][i] = this.paldata[0]; this.pal[1][i] = this.paldata[1];
        this.crtcTransparent();
        return;
      }
      case 0x4000: this.ay.writeAddr(v); return;
      case 0x4004: this.ay.writeData(v); return;
      case 0x6000: this.setBg(v); return;
      case 0x8000: this.outC = v; this.bv.setEnable((v >> 4) & 1); if (this.onOutput) this.onOutput('C', v); return;
      case 0x9000:
        this.eeprom.writeScl((v >> 2) & 1); this.sdaDir = (v >> 1) & 1; this.eeprom.writeSda(v & 1); return;
      case 0xa000: this.outB = v; if (this.onOutput) this.onOutput('B', v); return;
      case 0xc000:
        // hopper motors (bits 4, 5): once switched on the hopper runs by itself; rewriting the port with the motor still on
        // must not restart it (the firmware writes this port constantly)
        { const on = (v & 0x30) !== 0; if (on && !this.hopperOn) { this.coinOutLevel = 1; this.lastCoinOut = this.cpu.cycles; } this.hopperOn = on; if (!on) this.coinOutLevel = 0; this.coinOutState = on ? 3 : 0; }
        this.outA = v; if (this.onOutput) this.onOutput('A', v); return;
    }
    if (a >= 0xe000 && a < 0xe010) { this.duartWrite(a & 15, v); return; }
    const base = a & 0xf000;
    if (this.ram[base] && a >= 0x3000) this.ram[base][a & 0xfff] = v;
  }

  // Drop (lower) door at 0x9000 bit 0. Like the upper door it is a strobe: a closed door toggles between
  // samples. Montana samples it three times in a row and shifts the agreed bit into CMOS 0x133; 0x55/0xAA
  // means closed, 0x00/0xFF open (MAME returns a constant 0, i.e. open, which disables the bill validator
  // and switches the coin input into a single-pulse service mode).
  dropDoorRead() {
    const cyc = this.cpu.cycles;
    if (cyc - this.lastDrop > this.doorWait) { this.dropLevel = this.dropDoorClosed ? this.dropLevel ^ 1 : 0; this.lastDrop = cyc; }
    return this.dropLevel;
  }

  // ---------- DUART (2681-style) ----------
  // Channel A = slot accounting (unused here). Channel B = ticket printer at 2400 baud.
  // The printer answers control bytes (ENQ 05, DLE 10, DC1 11 ...) with ACK (06); the reply
  // raises "RxRDYB" (ISR bit 5) which, when enabled in IMR, pulls the 80C32's INT1 line.
  duartRead(r) {
    const d = this.duart;
    switch (r) {
      case 1: return 0x0c;                                    // SRA: TxRDY | TxEMT
      case 9: return 0x0c | (d.rxB.length ? 1 : 0);           // SRB: + RxRDY
      case 5: return this.duartIsr();
      case 11: { const v = d.rxB.length ? d.rxB.shift() : 0; this.duartIrq(); return v; }
      default: return 0;
    }
  }
  duartIsr() { return 0x11 | (this.duart.rxB.length ? 0x20 : 0); }
  duartIrq() { this.cpu.setInt(1, (this.duartIsr() & this.duart.imr) !== 0); }
  duartWrite(r, v) {
    const d = this.duart;
    if (r === 5) { d.imr = v; this.duartIrq(); return; }
    if (r === 3 && this.onPrinter) this.onPrinter(0, v);
    if (r === 11) {
      if (this.onPrinter) this.onPrinter(1, v);
      d.txCount++;
      // control bytes get an ACK about two character times later (2400 baud = ~4.2 ms per byte)
      // DC3 (13) asks for status; the next ENQ is then answered with a status digit ('0' = ready)
      // instead of ACK. Any other control byte is acknowledged.
      if (v === 0x13) { d.statusReq = true; return; }
      if (v < 0x20) {
        const r = (v === 0x05 && d.statusReq) ? 0x30 : 0x06;
        if (v === 0x05) d.statusReq = false;
        d.pending.push([this.cpu.cycles + Math.round(CYCLES_PER_SEC * 0.008), r]);
      }
    }
  }
  duartTick() {
    const d = this.duart;
    if (!d.pending.length) return;
    while (d.pending.length && d.pending[0][0] <= this.cpu.cycles) d.rxB.push(d.pending.shift()[1]);
    this.duartIrq();
  }

  // ---------- progressive link controller (Montana Choice / MG programs) ----------
  // The game only listens: the controller broadcasts one 8-byte packet per level on the 80C32's serial
  // port (mode 3, ~2400 baud): 0xNF (N = level), 1 BCD digit, 4 BCD bytes (most significant first,
  // value in cents), 00 00. The game wants the top level (count-1) to show up regularly and each
  // level to be at or above a minimum stored in ROM (0x01E8: $55, $500, $400, $200).
  linkTick() {
    const L = this.link;
    if (!L || this.cpu.cycles < L.next) return;
    L.next = this.cpu.cycles + CYCLES_PER_SEC * 11 / 2400;
    if (this.cpu.serialRxQ.length) return;
    if (!L.buf.length) {
      const lv = L.level; L.level = (L.level + 1) % L.amounts.length;
      const s = String(Math.floor(L.amounts[lv])).padStart(9, '0');
      const bcd = i => (+s[i] << 4) | +s[i + 1];
      L.buf = [(lv << 4) | 0x0f, +s[0], bcd(1), bcd(3), bcd(5), bcd(7), 0, 0];
    }
    this.cpu.serialRxQ.push(L.buf.shift());
    if (!L.buf.length) L.sent = (L.sent || 0) + 1;
  }

  // ---------- 6545 CRTC ----------
  crtcStatus() {
    let r = 0;
    if (!this.inDisplay()) r |= 0x20;
    if (this.crtc.lpen) r |= 0x40;
    if (this.crtc.ready) r |= 0x80;
    return r;
  }
  inDisplay() { const R = this.crtc.regs; const vd = (R[6] || 25) * ((R[9] || 7) + 1); return this.line < vd; }
  crtcRegR() {
    const c = this.crtc;
    switch (c.addr) {
      case 0x0e: return c.regs[0x0e]; case 0x0f: return c.regs[0x0f];
      case 0x10: return c.lpAddr >> 8;
      case 0x11: c.lpen = !!(this.pen && this.penSeen); return c.lpAddr & 0xff;   // a pen resting on the screen keeps seeing light
      case 0x1f: this.crtcTransparent(); return 0;
    }
    return 0;
  }
  crtcRegW(v) {
    const c = this.crtc;
    switch (c.addr) {
      case 0x12: c.update = ((v & 0x3f) << 8) | (c.update & 0xff); this.vid = c.update; break;
      case 0x13: c.update = (v) | (c.update & 0xff00); this.vid = c.update; break;
      case 0x1f: this.crtcTransparent(); break;
      default: c.regs[c.addr] = v;
    }
  }
  crtcTransparent() {
    const c = this.crtc;
    if (!(c.regs[8] & 0x08)) return;
    c.update = (c.update + 1) & 0x3fff;
    if ((c.regs[8] & 0x88) === 0x88) this.vid = c.update;
    else { c.ready = false; c.pending = true; }
  }

  // ---------- inputs ----------
  keyCode(bank) {
    const v = this.keys[bank];
    let code = 0;
    for (let b = 0; b < 7; b++) if (v & (1 << b)) code = b + 1;
    return code;
  }
  input0() {
    const c1 = this.keyCode(1), c2 = this.keyCode(2);
    let v = ((~c1) & 7) | (this.penDown ? 0 : 0x08) | (((~c2) & 7) << 4) | (this.cardCage ? 0x80 : 0);
    // the validator's credit line is key code 7 on the encoded bank-2 lines (IN_BANK2 bit 0x40, "Bill Acceptor");
    // the lines are active low here, so a pulse pulls bits 4-6 low (MAME ORs 0x70 in, which is the idle level)
    if (this.bv.line(this.cpu.cycles)) v &= ~0x70;
    return v;
  }
  inputBankA() {
    let sda = 0;
    if (!this.sdaDir) sda = this.eeprom.readSda();
    const cyc = this.cpu.cycles;
    if (this.sensor && this.coinState === 0) { this.coinState = 1; this.lastCycles = cyc; }
    else if (cyc - this.lastCycles > this.coinStep && this.coinState !== 0) {
      if (++this.coinState > 5) this.coinState = 0;
      this.lastCycles = cyc;
    }
    // Montana Choice runs its coin input in single-pulse mode: only optic B goes active, once per coin.
    const optics = this.coinPulse ? (this.coinState >= 1 && this.coinState <= 3 ? 2 : 0) : [0, 1, 3, 7, 6, 4][this.coinState];
    if (cyc - this.lastDoor > this.doorWait) {
      if (this.doorUpperClosed) this.doorOpen = this.doorCycle ? (this.doorOpen ^ 1) & 1 : 0;
      else this.doorOpen = 1;
      this.lastDoor = cyc;
    }
    // coin-out optic: one pulse per coin, 120 ms high / 120 ms low while a hopper motor runs (MAME uses 60 ms, but then programs with a slow main loop count a few coins too many and tilt with EXTRA COIN OUT). The level
    // only changes when the firmware reads the port, so a phase can never fall between two reads and go unseen.
    if (this.hopperOn && cyc - this.lastCoinOut > (+(typeof process !== 'undefined' && process.env.HOPPH) || 100000)) { this.coinOutLevel ^= 1; this.lastCoinOut = cyc; }
    const coinOut = this.hopperOn && this.coinOutLevel ? 0x08 : 0;
    if (coinOut && !this.lastCoinOutBit) this.coinsOut = (this.coinsOut || 0) + 1;
    this.lastCoinOutBit = coinOut;
    return (sda << 7) | 0x50 | (this.doorOpen << 5) | optics | coinOut;
  }

  // ---------- UI-facing controls ----------
  press(name, down) {
    const k = KEYS[name]; if (!k) return;
    if (down) this.keys[k[0]] |= k[1]; else this.keys[k[0]] &= ~k[1];
  }
  // The firmware drives the coin acceptor's lockout coil from output bank A bit 0 (1 = accepting; it drops to 0 when the
  // game cannot take credit: maximum coins in, not set up, tilt). A locked-out acceptor rejects the coin mechanically, so
  // it falls back to the tray and never reaches the optics or the coin-in meter.
  insertCoin() {
    if (!(this.outA & 1)) { this.coinsReturned = (this.coinsReturned || 0) + 1; if (this.onCoinReturn) this.onCoinReturn(); return false; }
    this.sensor = 1; this.sensorUntil = this.frame + 2; this.coinsIn = (this.coinsIn || 0) + 1; return true;
  }
  // dollars: 1, 5, 10, 20 (and 2, 50, 100 on ID-022/023); false if the game has the validator disabled or busy
  insertBill(dollars) { return this.bv.insert(dollars || 1); }
  setDoor(open) { this.doorUpperClosed = !open; }

  // ---------- running ----------
  // Operator initialisation (CMOS + EEPROM data screens) driven like a technician would:
  // door open, self-test, self-test, door closed. Runs from runFrame().
  // mode: 'tap' (older Plus programs: door open, two short taps of the test switch), 'hold' (Superboard / newer programs:
  // the test switch must be held ~3 s), 'both' (taps, then the hold sequence). Default: 'hold' for Superboard, else 'tap'.
  startAutoSetup(mode) {
    const T = (n, f) => [n, f];
    const tap = () => [T(60, () => this.press('test', true)), T(30, () => this.press('test', false))];
    const jp = () => [T(8, () => this.press('jackpot', true)), T(30, () => this.press('jackpot', false)), T(300, () => {})];
    const hold = () => [T(250, () => this.press('test', true)), T(300, () => this.press('test', false))];
    mode = mode || (this.roms.superData ? 'hold' : 'tap');
    const taps = [T(600, () => {}), T(100, () => this.setDoor(true)), ...tap(), T(this.roms.plus ? 500 : 200, () => {}),
      ...(this.roms.plus ? [...tap(), T(200, () => {})] : []), T(200, () => this.setDoor(false)), T(400, () => {})];
    // "CMOS DATA", then door closed + jackpot reset, door open again for "EEPROM DATA", door closed (MAME's "method 2")
    const holdSeq = [T(300, () => this.setDoor(true)), ...hold(), T(400, () => this.setDoor(false)), ...jp(),
      T(400, () => this.setDoor(true)), ...hold(), T(600, () => this.setDoor(false)), T(600, () => {})];
    this.setup = mode === 'hold' ? [T(900, () => {}), ...holdSeq] : mode === 'both' ? taps.concat(holdSeq) : taps;
    // Montana Choice (MG programs): jackpot reset recovers CMOS, door + test initialises the EEPROM,
    // door closed, then a second jackpot reset clears the remaining call-attendant message.
    if (this.link) {
      const j2 = () => [T(8, () => this.press('jackpot', true)), T(200, () => this.press('jackpot', false))];
      this.setup = [T(900, () => {}), ...j2(), T(100, () => this.setDoor(true)), T(60, () => this.press('test', true)),
        T(200, () => this.press('test', false)), T(200, () => this.setDoor(false)), ...j2(), T(600, () => {})];
    }
    this.setupLeft = 0; this.setupBusy = true;
  }
  // after a set chip changed the denomination in the saved memory the game reports "CMOS DATA": recover it
  // (hold the test switch, door closed, jackpot reset) and keep the EEPROM.
  startRecover() {
    const T = (n, f) => [n, f];
    this.setup = [T(900, () => {}), T(300, () => this.setDoor(true)), T(250, () => this.press('test', true)), T(300, () => this.press('test', false)),
      T(400, () => this.setDoor(false)), T(8, () => this.press('jackpot', true)), T(30, () => this.press('jackpot', false)), T(600, () => {})];
    this.setupLeft = 0; this.setupBusy = true;
  }
  stepSetup() {
    if (!this.setup) return;
    if (this.setupLeft > 0) { this.setupLeft--; return; }
    const step = this.setup.shift();
    if (!step) { this.setup = null; this.setupBusy = false; return; }
    // each entry runs its action, then waits n frames
    this.setupLeft = step[0]; step[1]();
  }
  // debug panel sections ([title] rows start a section)
  info() {
    const c = this.cpu, h = v => v.toString(16).toUpperCase().padStart(2, '0');
    const d = this.duart, L = this.link;
    const kb = n => (n / 1024) + ' KB';
    const rows = [['System'],
      ['architecture', 'Intel 80C32 (MCS-51 family, 8-bit CISC) · 10 MHz crystal, 0.83 million machine cycles/s'],
      ['program', kb(this.roms.prog.length) + ' ROM' + (this.roms.superData ? ' + 64 KB Superboard data ROM' : '') + ' · ' + (this.roms.plus ? 'Plus board' : 'original board')],
      ['memory', '8 KB battery-backed CMOS · 256-byte serial EEPROM · 256 bytes on-chip RAM'],
      ['video', 'MC6545 CRTC, 8×8 tile graphics (' + kb(this.roms.cg[0].length * 4) + ' graphics ROMs), 320×200, colour PROM palette'],
      ['serial', 'SCN2681 DUART (channel B: ticket printer)'],
      ['running', (this.cpu.cycles / CYCLES_PER_SEC).toFixed(0) + ' s emulated'],
      ['doors', 'upper ' + (this.doorUpperClosed ? 'closed' : 'OPEN') + ' · drop ' + (this.dropDoorClosed ? 'closed' : 'OPEN')],
      ['Sound'], ['sound chip', this.ay.info()],
      ['Coins'], ['coin acceptor', (this.coinsIn || 0) + ' inserted · ' + (this.coinsOut || 0) + ' paid out · ' + (this.coinsReturned || 0) + ' returned' + (this.coinPulse ? ' · single-pulse' : '')],
      ['hopper', this.coinOutState ? 'paying' : 'idle'],
      ['Bill validator'], ...this.bv.info(),
      ['Printer'], ['ticket printer', d.txCount ? 'DUART B · ' + d.txCount + ' bytes sent · ' + (d.statusReq ? 'status request pending' : 'ready') : 'DUART B · no output yet']];
    if (L) rows.push(['Progressive link'], ['levels', L.amounts.map((a, i) => i + ': $' + (a / 100).toFixed(2)).join('  ')], ['packets', (L.sent || 0) + ' sent']);
    return rows;
  }
  // Light pen (keno): the pen switch is IN0 bit 3 (active low); every frame the 6545 latches the screen address under the pen
  // (as MAME does at vsync), which the firmware reads back from CRTC registers 16 / 17. x, y are screen pixels (320 x 200).
  // the pen sees light on every scan line of the character row it points at, so the 6545 latches the address (and sets
  // "LPEN register full") up to 8 times per frame; the firmware samples the registers several times and takes the majority
  penLine(ln) {
    const p = this.pen; if (!p) return;
    const row = Math.floor(p.y / 8);
    if (ln < row * 8 || ln >= row * 8 + 8) return;
    const c = this.crtc, R = c.regs, cols = R[1] || 40;
    c.lpAddr = ((((R[12] & 0x3f) << 8) | R[13]) + row * cols + Math.floor(p.x / 8) + 2) & 0x3fff;   // the pen circuit latches the address two characters late (the firmware subtracts 2)
    c.lpen = true; this.penSeen = true;
  }
  setPen(x, y, down) { this.pen = { x, y }; this.penDown = !!down; }
  clearPen() { this.pen = null; this.penDown = false; }
  runFrame() {
    this.stepSetup();
    this.penSeen = false;
    const base = this.cpu.cycles;
    for (let ln = 0; ln < LINES; ln++) {
      this.line = ln;
      this.penLine(ln);
      this.crtcLine(ln);
      this.duartTick();
      this.linkTick();
      const target = base + (ln + 1) * FRAME_CYCLES / LINES;
      const n = target - this.cpu.cycles;
      if (n > 0) this.cpu.run(n);
    }
    this.frame++;
    if (this.sensor && this.frame >= this.sensorUntil) this.sensor = 0;
    if (this.onAudio) {
      const n = 735, L = new Float32Array(n), R = new Float32Array(n);
      this.ay.render(L, R, 0, n);
      this.onAudio(L, R);
    }
  }
  crtcLine(ln) {
    const c = this.crtc, R = c.regs;
    if (c.pending) { c.ready = true; c.pending = false; if ((R[8] & 0x88) !== 0x88) this.vid = c.update; }
    const ch = (R[9] || 7) + 1;
    const vs = (R[7] || 28) * ch, w = ((R[3] >> 4) || 16);
    if (ln === vs) { c.vsync = true; this.cpu.setInt(0, true); }
    else if (c.vsync && ln === vs + w) { c.vsync = false; this.cpu.setInt(0, false); }
  }

  getNV() {
    const o = new Uint8Array(0x2000 + 0x200);
    o.set(this.cmos, 0); o.set(this.eeprom.data, 0x2000);
    return o;
  }
  setNV(b) {
    if (!b || b.length !== 0x2200) return;
    this.cmos.set(b.subarray(0, 0x2000)); this.eeprom.data.set(b.subarray(0x2000));
  }
}

PEPlus.KEYS = KEYS;
if (typeof module !== 'undefined') module.exports = { PEPlus }; else window.PEPlus = PEPlus;
})();
