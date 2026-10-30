// Player's Edge (Plus) bill validator. It drives one line into the CPU: the encoded bank-2 key lines
// (IN0 bits 4-6) pulled low, i.e. key code 7 "Bill Acceptor". The game answers on output C bit 4
// (validator enable), which it also toggles to acknowledge a bill.
//
// Protocols (times in ms of emulated time):
//  'count'  - Montana Choice (MG programs), decoded at 0x7FFE-0x8183 of MG0225 (flags in CMOS 0x32F,
//             pulse count 0x332, decoder tick ~2.15 ms). A bill of $N is N pulses: N-1 medium pulses
//             (32-86 ms on, gap shorter than 86 ms) and a final long pulse (86-129 ms). After an 86 ms quiet
//             gap the game accepts N = 1, 5, 10 or 20 and toggles the enable line; the validator then
//             reports "stacked" with one 13-32 ms pulse and the game credits the bill. If the game does not
//             toggle within 0.6 s it rejected the bill (it is returned).
//  'id022'  - IGT ID-022 as in MAME's peplus.cpp: 20 ms on/off pulses per denomination step, 50 ms stop,
//             wait for 3 toggles, 10 ms stacked pulse.
//  'id023'  - IGT ID-023 as in MAME: 50 ms start, 15-bit code sent three times, toggles, two stacked pulses.
'use strict';
(function () {
const ID022 = { 1: 0x00, 2: 0x01, 5: 0x04, 10: 0x09, 20: 0x13, 50: 0x16, 100: 0x18 };
const ID023 = { 1: 0x4a6c, 2: 0x4a7b, 5: 0x4a4b, 10: 0x4a5a, 20: 0x4a2b, 50: 0x4a0a, 100: 0x4a19 };

class PEBillValidator {
  // cyclesPerMs: CPU machine cycles per millisecond
  constructor(cyclesPerMs, protocol) {
    this.cpm = cyclesPerMs; this.protocol = protocol || 'id022';
    this.en = 0; this.toggles = 0; this.lastEn = 0;
    this.wave = null;          // [[startMs, endMs], ...] active periods, relative to t0
    this.phase = 'idle';       // idle | sending | waitack | stacking
    this.t0 = 0; this.bill = 0; this.log = [];
    this.stats = { inserted: 0, stacked: 0, returned: 0, dollars: 0 };
    this.onEvent = null; this.pending = [];
  }
  get accepts() { return this.protocol === 'count' ? [1, 5, 10, 20] : [1, 2, 5, 10, 20, 50, 100]; }
  setEnable(v) {
    if (v !== this.en && this.phase === 'waitack') this.toggles++;
    if (v) this.everEnabled = true;
    this.en = v;
  }
  // queues a bill; it goes in as soon as the game enables the validator. false if the denomination
  // can't be sent with this protocol.
  insert(dollars) {
    if (!this.accepts.includes(dollars)) return false;
    if (this.pending.length < 20) this.pending.push(dollars);
    return true;
  }
  start(dollars, now) {
    const w = [];
    if (this.protocol === 'count') {
      let t = 0;
      for (let i = 0; i < dollars - 1; i++) { w.push([t, t + 50]); t += 100; }
      w.push([t, t + 100]); this.ackFrom = t + 100;
    } else if (this.protocol === 'id022') {
      let t = 0; const n = ID022[dollars];
      for (let i = 0; i < n; i++) { w.push([t, t + 20]); t += 40; }
      w.push([t, t + 50]); this.ackFrom = t + 50;
    } else {
      let t = 0; const code = ID023[dollars];
      for (let loop = 0; loop < 3; loop++) {
        w.push([t, t + 50]); t += 70;
        for (let bit = 14; bit >= 0; bit--) { if (!((code >> bit) & 1)) w.push([t, t + 20]); t += 40; }
        t += 290;
      }
      this.ackFrom = t;
    }
    this.wave = w; this.t0 = now; this.bill = dollars; this.phase = 'sending'; this.toggles = 0;
    this.stats.inserted++; this.event('inserted');
  }
  event(what) { this.log.unshift(what + ' $' + this.bill); this.log.length = Math.min(this.log.length, 6); if (this.onEvent) this.onEvent(what, this.bill); }
  // level of the line (1 = active) at CPU cycle 'now'
  line(now) {
    const ms = (now - this.t0) / this.cpm;
    switch (this.phase) {
      case 'idle':
        if (this.pending.length && this.en) { this.start(this.pending.shift(), now); return this.line(now); }
        return 0;
      case 'sending':
        if (ms >= this.ackFrom) { this.phase = 'waitack'; this.toggles = 0; this.ackStart = ms; return 0; }
        for (const [a, b] of this.wave) if (ms >= a && ms < b) return 1;
        return 0;
      case 'waitack':
        if (this.toggles >= 3) { this.phase = 'stacking'; this.stackAt = ms; return 1; }
        if (ms - this.ackStart > 600) { this.phase = 'idle'; this.stats.returned++; this.event('returned'); }
        return 0;
      case 'stacking': {
        const d = ms - this.stackAt, len = this.protocol === 'count' ? 20 : 10;
        if (this.protocol === 'id023' ? (d < 10 || (d >= 20 && d < 30)) : d < len) return 1;
        if (d > 40) { this.phase = 'idle'; this.stats.stacked++; this.stats.dollars += this.bill; this.event('stacked'); }
        return 0;
      }
    }
    return 0;
  }
  info() {
    const s = this.stats;
    return [['bill validator', this.protocol + ' · ' + this.phase + (this.en ? ' · enabled' : ' · disabled') + (this.pending.length ? ' · ' + this.pending.length + ' queued' : '')],
      ['bills', s.stacked + ' stacked ($' + s.dollars + ') · ' + s.returned + ' returned'],
      ['last bill events', this.log.join(', ') || '–']];
  }
}
if (typeof module !== 'undefined') module.exports = { PEBillValidator }; else window.PEBillValidator = PEBillValidator;
})();
