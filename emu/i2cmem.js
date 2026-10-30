// Generic I2C EEPROM (port of MAME's i2cmem.cpp): used for the X2404P in Player's Edge Plus.
'use strict';
(function () {
const IDLE = 0, DEVSEL = 1, ADDRHI = 2, ADDRLO = 3, DATAIN = 4, READSELACK = 5, DATAOUT = 6, RESET = 7;

class I2CMem {
  // readPage / writePage / size as in MAME: X2404P = (0x100, 8, 0x200)
  constructor(readPage, writePage, size) {
    this.readPage = readPage; this.writePage = writePage; this.size = size;
    this.data = new Uint8Array(size).fill(0xff);
    this.page = new Uint8Array(Math.max(writePage, 1));
    this.slave = 0xa0;
    this.scl = 0; this.sdaw = 0; this.sdar = 1; this.state = IDLE;
    this.bits = 0; this.shift = 0; this.devsel = 0; this.addrhi = 0; this.byteaddr = 0;
    this.pageOffset = 0; this.pageWritten = 0; this.wc = 0;
  }
  get skipHigh() { return this.size <= 0x800; }
  get mask() { return this.size - 1; }
  offset() { return this.byteaddr & this.mask; }
  selected() {
    const mask = 0xfe & ~(this.skipHigh ? this.mask >> 7 : 0);
    return (this.devsel & mask) === (this.slave & mask);
  }
  writeSda(s) {
    s &= 1;
    if (this.sdaw === s) return;
    this.sdaw = s;
    if (this.scl && this.sdar) {
      if (s) {                                   // stop
        if (this.pageWritten > 0) {
          const base = this.offset(), root = base & ~(this.writePage - 1);
          for (let i = 0; i < this.pageWritten; i++) this.data[root | ((base + i) & (this.writePage - 1))] = this.page[i];
          this.pageWritten = 0;
        }
        this.state = IDLE;
      } else { this.state = DEVSEL; this.bits = 0; }   // start
    }
  }
  writeScl(s) {
    if (this.scl === s) return;
    this.scl = s;
    switch (this.state) {
      case DEVSEL: case ADDRHI: case ADDRLO: case DATAIN:
        if (this.bits < 8) {
          if (s) { this.shift = ((this.shift << 1) | this.sdaw) & 0xff; this.bits++; }
        } else if (s) this.bits++;
        else if (this.bits === 8) {
          switch (this.state) {
            case DEVSEL:
              this.devsel = this.shift;
              if (this.devsel === 0) this.state = RESET;
              else if (!this.selected()) this.state = IDLE;
              else if ((this.devsel & 1) === 0) this.state = this.skipHigh ? ADDRLO : ADDRHI;
              else this.state = READSELACK;
              break;
            case ADDRHI: this.addrhi = this.shift; this.state = ADDRLO; break;
            case ADDRLO:
              this.byteaddr = this.shift | (this.skipHigh ? ((this.devsel & 0xfe) << 7) & this.mask : this.addrhi << 8);
              this.pageOffset = 0; this.pageWritten = 0; this.state = DATAIN; break;
            case DATAIN:
              if (this.wc) this.state = IDLE;
              else if (this.writePage > 0) {
                this.page[this.pageOffset] = this.shift;
                if (++this.pageOffset === this.writePage) this.pageOffset = 0;
                if (++this.pageWritten > this.writePage) this.pageWritten = this.writePage;
              } else { this.data[this.offset()] = this.shift; this.byteaddr++; }
              break;
          }
          if (this.state !== IDLE) this.sdar = 0;     // acknowledge
        } else { this.bits = 0; this.sdar = 1; }
        break;
      case READSELACK: this.bits = 0; this.state = DATAOUT; break;
      case DATAOUT:
        if (this.bits < 8) {
          if (s) this.bits++;
          else {
            if (this.bits === 0) {
              this.shift = this.data[this.offset()];
              this.byteaddr = (this.byteaddr & ~(this.readPage - 1)) | ((this.byteaddr + 1) & (this.readPage - 1));
            }
            this.sdar = (this.shift >> 7) & 1;
            this.shift = (this.shift << 1) & 0xff;
          }
        } else if (s) {
          if (this.sdaw) this.state = IDLE;
          this.bits = 0;
        } else this.sdar = 1;
        break;
      case RESET:
        if (s) { if (this.bits > 8) { this.state = IDLE; this.sdar = 1; } this.bits++; }
        break;
    }
  }
  readSda() { return this.state === IDLE ? this.sdaw & 1 : this.sdar & 1; }
}
if (typeof module !== 'undefined') module.exports = { I2CMem }; else window.I2CMem = I2CMem;
})();
