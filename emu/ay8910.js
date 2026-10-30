// General Instrument AY-3-8910/8912 PSG: 3 square tones, noise, envelope generator.
'use strict';
(function () {
// 16-level DAC curve (relative amplitude), as measured for the AY-3-8910
const VOL = [0, 0.0100, 0.0145, 0.0211, 0.0307, 0.0455, 0.0645, 0.1073, 0.1266, 0.2050, 0.2922, 0.3728, 0.4925, 0.6353, 0.8056, 1.0];

class AY8910 {
  constructor(clock, rate) {
    this.clock = clock; this.rate = rate || 44100;
    this.reg = new Uint8Array(16);
    this.addr = 0;
    this.cnt = [0, 0, 0]; this.out = [0, 0, 0];
    this.ncnt = 0; this.lfsr = 1; this.nout = 1;
    this.ecnt = 0; this.estep = 0; this.eholding = false; this.eattack = false; this.evol = 0;
    this.acc = 0;
    this.lastL = 0;
  }
  // debug: per channel tone period / volume, mixer
  info() {
    const r = this.reg, ch = i => {
      const on = !((r[7] >> i) & 1), vol = r[8 + i] & 0x10 ? 'env' : (r[8 + i] & 15);
      return 'ABC'[i] + ' ' + (on && vol ? (((r[i * 2 + 1] & 15) << 8) | r[i * 2]) + '/' + vol : '-');
    };
    return 'AY-3-8912 · ' + [0, 1, 2].map(ch).join('  ') + (((r[7] >> 3) & 7) !== 7 ? '  noise ' + (r[6] & 31) : '');
  }
  writeAddr(v) { this.addr = v & 0x0f; }
  writeData(v) {
    this.reg[this.addr] = v;
    if (this.addr === 13) this.startEnv();
  }
  readData() { if (this.addr === 14 && this.portA) return this.portA(); return this.reg[this.addr]; }
  startEnv() {
    const sh = this.reg[13] & 15;
    this.estep = 0; this.eholding = false;
    this.eattack = (sh & 4) !== 0;
    this.ecnt = 0;
  }
  tick() {            // one tick = 8 chip clocks (a tone toggles every `period` ticks)
    const r = this.reg;
    for (let c = 0; c < 3; c++) {
      const p = (r[c * 2] | ((r[c * 2 + 1] & 15) << 8)) || 1;
      if (++this.cnt[c] >= p) { this.cnt[c] = 0; this.out[c] ^= 1; }
    }
    const np = (r[6] & 31) || 1;
    if (++this.ncnt >= np * 2) {
      this.ncnt = 0;
      const bit = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 16);
      this.nout = this.lfsr & 1;
    }
    const ep = (r[11] | (r[12] << 8)) || 1;
    if (!this.eholding && ++this.ecnt >= ep * 2) {
      this.ecnt = 0;
      if (++this.estep >= 16) {
        const sh = r[13] & 15;
        if (!(sh & 8) || (sh & 1)) {              // one-shot
          this.eholding = true;
          const hold = (sh & 8) ? ((sh & 2) ? !this.eattack : this.eattack) : false;  // final level
          this.estep = 15; this.efinal = (sh & 8) ? ((sh & 2) ? (this.eattack ? 0 : 15) : (this.eattack ? 15 : 0)) : 0;
          if (!(sh & 8)) this.efinal = 0;
          void hold;
        } else {
          this.estep = 0;
          if (sh & 2) this.eattack = !this.eattack;   // alternate
        }
      }
    }
    this.evol = this.eholding ? this.efinal : (this.eattack ? this.estep : 15 - this.estep);
  }
  // mix n samples into L, R (mono)
  render(L, R, off, n, gain) {
    gain = gain === undefined ? 0.25 : gain;
    const r = this.reg, tps = this.clock / 8 / this.rate;
    for (let i = 0; i < n; i++) {
      this.acc += tps;
      let sum = 0, cnt = 0;
      while (this.acc >= 1) {
        this.acc -= 1; this.tick();
        const mix = r[7];
        let s = 0;
        for (let c = 0; c < 3; c++) {
          const tone = (mix >> c) & 1 ? 1 : this.out[c];
          const noise = (mix >> (c + 3)) & 1 ? 1 : this.nout;
          if (tone & noise) {
            const a = r[8 + c];
            s += VOL[a & 0x10 ? this.evol : (a & 15)];
          }
        }
        sum += s; cnt++;
      }
      const v = (cnt ? sum / cnt : this.lastL) * gain;
      this.lastL = cnt ? sum / cnt : this.lastL;
      L[off + i] += v; R[off + i] += v;
    }
  }
}
if (typeof module !== 'undefined') module.exports = { AY8910 }; else window.AY8910 = AY8910;
})();
