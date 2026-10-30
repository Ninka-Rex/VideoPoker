// Identify and assemble a Player's Edge (Plus) ROM set from a list of {name, data} files.
'use strict';
(function () {
function buildPEPlusRoms(files) {
  const cg = [], r = {};
  let prog = null, prom = null, progName = '', superData = null;
  for (const f of files) {
    const n = f.name.split(/[\/]/).pop().toLowerCase();
    let m;
    if ((m = /^m([rgbx])[o0]-c[gf]\d+/.exec(n))) { cg['rgbx'.indexOf(m[1])] = f.data; }
    else if (/^cap[x\d]/.test(n)) prom = f.data;
    else if (/\.u(58|68)$/.test(n) || /^(xp|xs|xk|xmp)\d+\.u67$/.test(n) || /^pp\d+_[^_]*\.u67$/.test(n) || /^\w*\d+v[yz]\.u65$/.test(n)) { prog = f.data; progName = n; }   // Superboard / KOC programs, Player's Choice
    else if (/^x(m?\d+)[a-z]\.u66$/.test(n) || /_data_.*\.u66$/.test(n)) superData = f.data;                      // Superboard data ROM
  }
  if (!prog || !prom || cg.length !== 4 || cg.some(x => !x)) return null;
  const plus = prog.length >= 0x10000;
  return { prog, prom, cg, plus, sw1: plus ? 0xff : 0x5b, name: progName, superData };
}
function peFamily(progName) {
  const p = (progName || '').slice(0, 2);
  return { xp: 'poker', xs: 'slots', xk: 'keno', xm: 'poker', pp: 'poker', pk: 'poker', pp: 'poker', ip: 'poker', be: 'blackjack', ps: 'slots', mg: 'poker', ke: 'keno' }[p] || 'poker';
}
if (typeof module !== 'undefined') module.exports = { buildPEPlusRoms, peFamily }; else { window.buildPEPlusRoms = buildPEPlusRoms; window.peFamily = peFamily; }
})();
