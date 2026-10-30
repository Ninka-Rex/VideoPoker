// Yamaha YM2413 (OPLL) FM synthesizer.
// Game King drives it at 0x28050000 (register select) / 0x28050002 (data).
// Floating-point model of the chip: 9 two-operator channels, ADSR envelopes in dB,
// key scaling, tremolo/vibrato, modulator feedback, half-sine waveforms and a
// simplified rhythm section. Built-in instruments come from the chip's preset
// ROM (ym2413_instruments.bin: 15 melodic + 3 rhythm patches, 8 bytes each).
'use strict';

const OPLL_ROM = [
  0x71,0x61,0x1e,0x17,0xd0,0x78,0x00,0x17, 0x13,0x41,0x1a,0x0d,0xd8,0xf7,0x23,0x13,
  0x13,0x01,0x99,0x00,0xf2,0xc4,0x11,0x23, 0x31,0x61,0x0e,0x07,0xa8,0x64,0x70,0x27,
  0x32,0x21,0x1e,0x06,0xe0,0x76,0x00,0x28, 0x31,0x22,0x16,0x05,0xe0,0x71,0x00,0x18,
  0x21,0x61,0x1d,0x07,0x82,0x81,0x10,0x07, 0x23,0x21,0x2d,0x14,0xa2,0x72,0x00,0x07,
  0x61,0x61,0x1b,0x06,0x64,0x65,0x10,0x17, 0x41,0x61,0x0b,0x18,0x85,0xf7,0x71,0x07,
  0x13,0x01,0x83,0x11,0xfa,0xe4,0x10,0x04, 0x17,0xc1,0x24,0x07,0xf8,0xf8,0x22,0x12,
  0x61,0x50,0x0c,0x05,0xc2,0xf5,0x20,0x42, 0x01,0x01,0x55,0x03,0xc9,0x95,0x03,0x02,
  0x61,0x41,0x89,0x03,0xf1,0xe4,0x40,0x13, 0x01,0x01,0x18,0x0f,0xdf,0xf8,0x6a,0x6d,
  0x01,0x01,0x00,0x00,0xc8,0xd8,0xa7,0x48, 0x05,0x01,0x00,0x00,0xf8,0xaa,0x59,0x55,
];

const OPLL_MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const OPLL_KSL = [0, 24, 32, 37, 40, 43, 45, 47, 48, 50, 51, 52, 53, 54, 55, 56].map(x => x * 0.75);
const OPLL_KSL_SCALE = [0, 0.25, 0.5, 1];
const SINE_BITS = 12, SINE_N = 1 << SINE_BITS;
const SINE = new Float32Array(SINE_N);
for (let i = 0; i < SINE_N; i++) SINE[i] = Math.sin(2 * Math.PI * i / SINE_N);
const EG_MAX = 48;                       // dB of attenuation treated as silence

function opllWave(phaseCycles, rectified) {
  const p = phaseCycles - Math.floor(phaseCycles);
  const s = SINE[(p * SINE_N) | 0];
  return rectified && s < 0 ? 0 : s;
}

class OPLLSlot {
  constructor() { this.phase = 0; this.eg = EG_MAX; this.stage = 'off'; this.o1 = 0; this.o2 = 0; }
}

class OPLL {
  constructor(rate) {
    this.rate = rate || 44100;
    this.clock = 3579545;
    this.reg = new Uint8Array(64);
    this.addr = 0;
    this.slots = [];
    for (let i = 0; i < 18; i++) this.slots.push(new OPLLSlot());
    this.keyOn = new Uint8Array(9);
    this.rhythmKeys = 0;
    this.t = 0;
    this.noise = 1;
  }
  reset() { this.reg.fill(0); for (const s of this.slots) { s.eg = EG_MAX; s.stage = 'off'; } this.keyOn.fill(0); this.rhythmKeys = 0; }

  write(a, d) {
    if (!(a & 2)) { this.addr = d & 0x3f; return; }
    const r = this.addr;
    this.reg[r] = d;
    if (r >= 0x20 && r <= 0x28) {
      const ch = r - 0x20, on = (d >> 4) & 1;
      if (on && !this.keyOn[ch]) this.keyChannel(ch, true);
      else if (!on && this.keyOn[ch]) this.keyChannel(ch, false);
      this.keyOn[ch] = on;
    } else if (r === 0x0e) {
      const keys = d & 0x1f, old = this.rhythmKeys;
      if (d & 0x20) {
        // bit4 BD (ch6 both slots), bit3 SD (ch7 car), bit2 TOM (ch8 mod), bit1 CYM (ch8 car), bit0 HH (ch7 mod)
        const map = [[4, [12, 13]], [3, [15]], [2, [16]], [1, [17]], [0, [14]]];
        for (const [bit, sl] of map) {
          const now = (keys >> bit) & 1, was = (old >> bit) & 1;
          if (now && !was) for (const s of sl) this.keySlot(this.slots[s], true);
          else if (!now && was) for (const s of sl) this.keySlot(this.slots[s], false);
        }
      }
      this.rhythmKeys = keys;
    }
  }
  read() { return 0xff; }

  keySlot(s, on) {
    if (on) { s.stage = 'attack'; s.phase = 0; s.o1 = s.o2 = 0; }
    else if (s.stage !== 'off') s.stage = 'release';
  }
  keyChannel(ch, on) { this.keySlot(this.slots[ch * 2], on); this.keySlot(this.slots[ch * 2 + 1], on); }

  patch(ch) {
    const rhythm = (this.reg[0x0e] & 0x20) && ch >= 6;
    const inst = rhythm ? 16 + (ch - 6) : (this.reg[0x30 + ch] >> 4);
    if (inst === 0) return this.reg.subarray(0, 8);
    const o = (inst - 1) * 8;
    return OPLL_ROM.slice(o, o + 8);
  }

  // envelope step for one slot; dt in seconds. Returns attenuation in dB.
  envelope(s, p, isCar, kcode, sus, dt) {
    const ar = p[isCar ? 5 : 4] >> 4, dr = p[isCar ? 5 : 4] & 15;
    const sl = p[isCar ? 7 : 6] >> 4, rr = p[isCar ? 7 : 6] & 15;
    const eg = (p[isCar ? 1 : 0] >> 5) & 1, ksr = (p[isCar ? 1 : 0] >> 4) & 1;
    const rks = ksr ? kcode : kcode >> 2;
    const eff = rate => rate ? Math.min(63, rate * 4 + rks) : 0;
    const decayPerSec = rate => { const R = eff(rate); return R ? EG_MAX / (19.64 * Math.pow(2, (4 - R) / 4)) : 0; };
    switch (s.stage) {
      case 'attack': {
        const R = eff(ar);
        if (R >= 60) s.eg = 0;
        else if (R) { const tau = 2.826 * Math.pow(2, (4 - R) / 4) / 6.2; s.eg -= s.eg * (1 - Math.exp(-dt / tau)); }
        if (s.eg < 0.1) { s.eg = 0; s.stage = 'decay'; }
        break;
      }
      case 'decay':
        s.eg += decayPerSec(dr) * dt;
        if (s.eg >= sl * 3) { s.eg = sl * 3; s.stage = 'sustain'; }
        break;
      case 'sustain':
        if (!eg) s.eg += decayPerSec(rr) * dt;        // percussive tone keeps falling
        break;
      case 'release':
        s.eg += decayPerSec(sus ? 5 : (eg ? rr : 7)) * dt;
        break;
    }
    if (s.eg >= EG_MAX) { s.eg = EG_MAX; if (s.stage === 'release' || s.stage === 'sustain') s.stage = 'off'; }
    return s.eg;
  }

  // mix `n` samples into L/R starting at offset
  render(L, R, off, n, gain) {
    gain = gain === undefined ? 0.6 : gain;
    const dt = 1 / this.rate;
    const fsNative = this.clock / 72;
    const rhythm = (this.reg[0x0e] & 0x20) !== 0;
    for (let ch = 0; ch < 9; ch++) {
      const mod = this.slots[ch * 2], car = this.slots[ch * 2 + 1];
      if (mod.stage === 'off' && car.stage === 'off') continue;
      const p = this.patch(ch);
      const fnum = this.reg[0x10 + ch] | ((this.reg[0x20 + ch] & 1) << 8);
      const block = (this.reg[0x20 + ch] >> 1) & 7;
      const sus = (this.reg[0x20 + ch] >> 5) & 1;
      const kcode = (block << 1) | (fnum >> 8);
      const baseHz = fnum * Math.pow(2, block) * fsNative / (1 << 19);
      const kslBase = Math.max(0, OPLL_KSL[fnum >> 5] - 6 * (7 - block));
      const mm = OPLL_MULT[p[0] & 15], cm = OPLL_MULT[p[1] & 15];
      const modAtt0 = (p[2] & 63) * 0.75 + kslBase * OPLL_KSL_SCALE[p[2] >> 6];
      const vol = rhythm && ch >= 6 ? 0 : (this.reg[0x30 + ch] & 15);
      const carAtt0 = vol * 3 + kslBase * OPLL_KSL_SCALE[p[3] >> 6];
      const dc = (p[3] >> 4) & 1, dm = (p[3] >> 3) & 1, fb = p[3] & 7;
      const amM = (p[0] >> 7) & 1, amC = (p[1] >> 7) & 1, pmM = (p[0] >> 6) & 1, pmC = (p[1] >> 6) & 1;
      // rhythm channels: per-instrument volumes and noise-based voices
      let rVolM = 0, rVolC = 0;
      if (rhythm && ch >= 6) {
        const v = this.reg[0x30 + ch];
        if (ch === 6) rVolM = rVolC = (v & 15) * 3;
        else { rVolM = (v >> 4) * 3; rVolC = (v & 15) * 3; }
      }
      for (let k = 0; k < n; k++) {
        const t = this.t + k * dt;
        const am = 4.8 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * t));
        const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 6.4 * t);
        const egM = this.envelope(mod, p, false, kcode, sus, dt);
        const egC = this.envelope(car, p, true, kcode, sus, dt);
        mod.phase += baseHz * mm * (pmM ? vib : 1) * dt;
        car.phase += baseHz * cm * (pmC ? vib : 1) * dt;
        const attM = egM + modAtt0 + (amM ? am : 0) + rVolM;
        const attC = egC + carAtt0 + (amC ? am : 0) + rVolC;
        let out;
        if (rhythm && ch >= 7) {
          // HH / SD (ch7) and TOM / CYM (ch8): noise and tone approximations
          this.noise = (this.noise >>> 1) ^ ((this.noise & 1) ? 0x400181 : 0);
          const nz = (this.noise & 1) ? 1 : -1;
          const aM = attM >= EG_MAX ? 0 : Math.pow(10, -attM / 20);
          const aC = attC >= EG_MAX ? 0 : Math.pow(10, -attC / 20);
          if (ch === 7) out = nz * 0.5 * aM + (opllWave(car.phase, 0) * 0.5 + nz * 0.5) * aC;
          else out = opllWave(mod.phase, 0) * aM + nz * 0.6 * aC;
        } else {
          let fbPhase = 0;
          if (fb) fbPhase = (mod.o1 + mod.o2) * 0.5 * 2 * Math.pow(2, fb - 7);
          const aM = attM >= EG_MAX ? 0 : Math.pow(10, -attM / 20);
          const mo = opllWave(mod.phase + fbPhase, dm) * aM;
          mod.o2 = mod.o1; mod.o1 = mo;
          const aC = attC >= EG_MAX ? 0 : Math.pow(10, -attC / 20);
          out = opllWave(car.phase + mo * 2, dc) * aC;
          if (rhythm && ch === 6) out *= 2;
        }
        L[off + k] += out * gain; R[off + k] += out * gain;
      }
    }
    this.t += n * dt;
  }
}

if (typeof module !== 'undefined') module.exports = { OPLL };
else window.OPLL = OPLL;
