// A minimal SAS host (slot accounting system) on a QUART channel, enough for ticket in / ticket out.
//
// Found in Triple-Five Play (g0001783): SAS runs on QUART1 channel 1 (19200 baud, multidrop: the host's
// address byte carries the 9th "wake-up" bit, reported to the CPU in SR bit 5). The machine stays silent
// until it has a SAS address (operator menu: Comm Options > IGT SAS > Primary Channel > Set Machine Address),
// and it ignores polls to its own address until it has seen a poll to some other address (flag 0x33f of the
// SAS state block), as on a real loop with several machines. So the host alternates a poll to a dummy
// address with a general poll (0x80 | address) to the machine.
//
// Vouchers: the machine prints them itself (standard validation) but can only take one back with the
// host's approval: exception 0x67 "ticket inserted" -> long poll 0x70 (send ticket validation data) ->
// the host looks the validation number up -> long poll 0x71 (redeem ticket, transfer code 00 + amount) ->
// the machine stacks it and posts exception 0x68 "ticket transfer complete" -> 0x71 with code 0xFF.
// Redemption only works in ENHANCED (or SYSTEM) validation mode (option byte 0x10029f34; STANDARD rejects
// every voucher with reason 0x8a at 0x08034520). In ENHANCED mode the host first gives the machine its
// validation ID with long poll 0x4C; after each voucher the machine posts exception 0x3D and the host reads the
// record (validation number, amount) with long poll 0x4D.
'use strict';
(function () {
function crc(bytes) {   // CRC-16/KERMIT, low byte first (same as Netplex)
  let c = 0;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return [c & 0xff, (c >> 8) & 0xff];
}
const bcd = (n, len) => { const s = String(n).padStart(len * 2, '0').slice(-len * 2); const a = []; for (let i = 0; i < len; i++) a.push(parseInt(s.substr(i * 2, 2), 16)); return a; };
const unbcd = a => a.map(b => (b >> 4) + '' + (b & 15)).join('');

const EXC = { 0x11: 'slot door opened', 0x12: 'slot door closed', 0x17: 'AC power applied', 0x18: 'AC power lost',
  0x3c: 'operator changed options', 0x3d: 'cash-out ticket printed', 0x3e: 'handpay validated', 0x51: 'handpay pending',
  0x52: 'handpay reset', 0x67: 'ticket inserted', 0x68: 'ticket transfer complete', 0x7e: 'game started', 0x7f: 'game ended',
  0x20: 'general tilt', 0x84: 'printer: comm/paper', 0x2b: 'bill accepted', 0x71: 'change lamp on', 0x72: 'change lamp off' };

class SASHost {
  // quart: QUART device, ch: channel, addr: the machine's SAS address
  constructor(quart, ch, addr) {
    this.q = quart; this.ch = ch; this.addr = addr || 1;
    this.rx = []; this.expect = null; this.wait = 0; this.turn = 0;
    this.tickets = new Map();      // validation number (18 digits) -> { cents, redeemed }
    this.log = []; this.polls = 0; this.answers = 0; this.lastExc = '';
    this.onEvent = null; this.validationId = 1; this.sequence = 1; this.idSent = false;
    const prev = quart.onTx;
    quart.onTx = (c, v) => { if (c === this.ch) this.rx.push(v); if (prev) prev(c, v); };
  }
  note(s) { this.log.unshift(s); if (this.log.length > 8) this.log.length = 8; if (this.onEvent) this.onEvent(s); }
  // a voucher the host knows about (printed by the machine, or read from a ticket file)
  register(validation, cents) {
    const v = String(validation).replace(/[^0-9]/g, '');
    if (v.length === 18 && !this.tickets.has(v)) this.tickets.set(v, { cents, redeemed: false });
  }
  send(bytes, wake) { this.q.receive(this.ch, bytes, 300, wake); }
  // data: variable-length body (sent with a length byte); fixed: fixed-length body (no length byte)
  longPoll(cmd, data, fixed) {
    const body = [this.addr, cmd].concat(data ? [data.length].concat(data) : (fixed || []));
    this.send(data || fixed ? body.concat(crc(body)) : body, true);
  }
  // call once per emulated frame
  tick() {
    if (this.expect) {
      if (this.parse()) { this.expect = null; return; }
      if (--this.wait > 0) return;
      this.expect = null; this.rx.length = 0;       // no (complete) answer: carry on polling
    }
    this.rx.length = 0;
    if (this.next) { const n = this.next; this.next = null; n(); return; }
    // enhanced validation: hand out the validation ID once the machine answers
    if (!this.idSent && this.answers > 3) {
      this.idSent = true;
      const id = this.validationId, sq = this.sequence;
      this.longPoll(0x4c, null, [id >> 16 & 255, id >> 8 & 255, id & 255, sq >> 16 & 255, sq >> 8 & 255, sq & 255]);
      this.expect = 0x4c; this.wait = 4; return;
    }
    // alternate: a poll to another address (the machine waits for one), then a general poll to it
    if ((this.turn ^= 1)) { this.send([0x80 | ((this.addr % 127) + 1)], true); return; }
    this.polls++; this.send([0x80 | this.addr], true); this.expect = 'gp'; this.wait = 3;
  }
  parse() {
    const r = this.rx;
    if (this.expect === 'gp') {
      if (!r.length) return false;
      const e = r[0]; this.answers++;
      if (e && e !== this.addr) { this.lastExc = (EXC[e] || 'exception') + ' (' + e.toString(16) + ')'; this.note('exception ' + e.toString(16) + ' ' + (EXC[e] || '')); }
      if (e === 0x67) this.next = () => { this.longPoll(0x70); this.expect = 0x70; this.wait = 4; };
      if (e === 0x68) this.next = () => { this.longPoll(0x71, [0xff]); this.expect = 0x71; this.wait = 4; };
      if (e === 0x3d || e === 0x3e) this.next = () => { this.longPoll(0x4d, null, [0x00]); this.expect = 0x4d; this.wait = 4; };
      if (e === 0x17) this.idSent = false;      // power-up: give the validation ID again
      return true;
    }
    // fixed-length answers
    if (this.expect === 0x4c) {
      if (r.length < 10) return false;
      this.note('validation id set (machine ' + ((r[2] << 16) | (r[3] << 8) | r[4]) + ')');
      return true;
    }
    if (this.expect === 0x4d) {
      // addr, 4D, type, index, date(4), time(3), validation(8), amount(5), ticket#(2), system id(1), expiry(4), pool(2), crc(2)
      if (r.length < 35) return false;
      const vd = unbcd([r[26]]) + unbcd(r.slice(11, 19)), cents = +unbcd(r.slice(19, 24));
      if (cents) { this.register(vd, cents); this.note('voucher ' + vd + ' $' + (cents / 100).toFixed(2) + ' recorded'); }
      return true;
    }
    // long poll answers: addr, cmd, length, data..., crc lo, crc hi
    if (r.length < 3 || r.length < r[2] + 5) return false;
    const data = r.slice(3, 3 + r[2]);
    if (this.expect === 0x70) {
      const status = data[0], parsing = data[6], vd = unbcd(data.slice(7, 16));
      if (status !== 0x00) { this.note('no ticket in escrow'); return true; }
      const t = this.tickets.get(vd);
      let code = 0x00, cents = 0;
      if (!t) { code = 0x82; this.note('ticket ' + vd + ' not in system'); }
      else if (t.redeemed) { code = 0x84; this.note('ticket ' + vd + ' already redeemed'); }
      else { cents = t.cents; this.note('redeeming ticket ' + vd + ' for $' + (cents / 100).toFixed(2)); }
      this.pending = vd;
      this.next = () => {
        this.longPoll(0x71, [code].concat(bcd(cents, 5), [parsing || 0], bcd(vd, 9), [0, 0, 0, 0], [0, 0]));
        this.expect = 0x71; this.wait = 4;
      };
      return true;
    }
    if (this.expect === 0x71) {
      const status = data[0];
      if (status === 0x00 && this.pending && this.tickets.has(this.pending)) {
        this.tickets.get(this.pending).redeemed = true; this.note('ticket ' + this.pending + ' redeemed'); this.pending = null;
      }
      return true;
    }
    return true;
  }
  info() {
    let open = 0; for (const t of this.tickets.values()) if (!t.redeemed) open++;
    return [['sas host', 'address ' + this.addr + ' · ' + this.answers + '/' + this.polls + ' polls answered'],
      ['sas last exception', this.lastExc || '–'],
      ['sas vouchers known', this.tickets.size + ' (' + open + ' unredeemed)'],
      ['sas log', this.log.slice(0, 3).join(' · ') || '–']];
  }
}
if (typeof module !== 'undefined') module.exports = { SASHost }; else window.SASHost = SASHost;
})();
