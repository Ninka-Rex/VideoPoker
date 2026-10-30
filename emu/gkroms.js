// Game King ROM sets (from MAME's gkigt.cpp): which file belongs to which chip, per set.
'use strict';
(function () {
// keychip: RAM word holding the inserted keychip type (non-zero unlocks the gray operator options);
//          found by following the "checking for keychip enable flag" boot step to its check routine.
// year:    year of manufacture = newest IGT copyright year in the set's base and game chips
const S = {
  gkigt4:    { title: 'Game King (v4.x)', year: 2003, base: 'm0000527 base,1-4002.bin', gme: 'g0001777', cg: 'c0000330', cgx: '2-40.bin', pxx: '2-80.bin', keychip: 0x10003ea0, devices: { billValidator: true, printer: true, sas: true } },
  gkigt4ms:  { title: 'Game King (v4.x, Multi-Strike)', year: 2003, base: 'm000526 base,1-4002,ms.u39', gme: 'g0001777', cgset: 'c000351', ms: true, keychip: 0x10003ea0, devices: { billValidator: true, printer: true, sas: true } },
  gkigt43:   { title: 'Game King (v4.3)', year: 2003, base: 'm0000837 base,1-4002.bin', gme: 'g0002142', cg: 'c0000793', keychip: 0x10015d70, devices: { billValidator: true, printer: true, sas: true } },
  gkigt43n:  { title: 'Game King (v4.3, New Jersey)', year: 2002, base: 'm0000811 base,1-4002,nj.bin', gme: 'g0001624', cg: 'c0000770', nj: true, keychip: 0x10014c90, devices: { billValidator: true, printer: true, sas: true } },
  gkigtez:   { title: 'Game King (EZ Pay, v4.0)', year: 2001, base: 'm000526 base,1-4002,ms.u39', gme: 'g0001126', cgset: 'c000351', ms: true, keychip: 0x100031f0, devices: { billValidator: true, printer: true, sas: true } },
  gkigtezms: { title: 'Game King (EZ Pay, v4.0, Multi-Strike)', year: 2005, base: 'm000526 base,1-4002,ms.u39', gme: 'g0002955', cgset: 'c000351', ms: true, keychip: 0x10003f60, devices: { billValidator: true, printer: true, sas: true } },
  gkigt5p:   { title: 'Game King (Triple-Five Play)', year: 2002, base: 'm0000761 base,1-4002.bin', gme: 'g0001783', cg: 'c0000517', keychip: 0x100154f0, devices: { billValidator: true, printer: true, sas: true } },
};
// returns { chip: filename-regex } for a set; files are matched by name anywhere under the ROM folder
// battery-backed RAM the set needs (bytes); v4.0 fits in 512 KB, the later firmware wants more
function nvSize(id) { return id === 'gkigt4' ? 0x80000 : 0x100000; }
// Netplex peripherals a set's saved setup expects (bill validator at 4, ticket printer at 2)
function peripherals(id) { return Object.assign({ billValidator: false, printer: false, sas: false }, (S[id] && S[id].devices) || {}); }
function hasBV(id) { return peripherals(id).billValidator; }
function patterns(id) {
  const s = S[id];
  const cg = s.cg || s.cgset;
  const esc = x => x.replace(/[.*+?^${}()|[\]\,]/g, '\$&');
  return {
    base: new RegExp('^' + esc(s.base) + '$', 'i'),
    gme1: new RegExp('^' + s.gme + ' gme1 1 of 2', 'i'), gme2: new RegExp('^' + s.gme + ' gme[12] 2 of 2', 'i'),
    cg1: new RegExp('^' + cg + ' cg1', 'i'), cg2: new RegExp('^' + cg + ' cg2', 'i'),
    plx1: new RegExp('^' + cg + ' p[lx][lx]1', 'i'), plx2: new RegExp('^' + cg + ' p[lx][lx]2', 'i'),
    snd1: /^swc00046 snd1/i, snd2: /^swc00046 snd2/i,
  };
}
if (typeof module !== 'undefined') module.exports = { SETS: S, patterns, nvSize, hasBV, peripherals }; else window.GK = { SETS: S, patterns, nvSize, hasBV, peripherals };
})();
