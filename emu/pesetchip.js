// Player's Edge Plus "set chip": many programs refuse to run ("SET DENOMINATION") until IGT's set chip has written the
// denomination to the EEPROM. The chip is a small program that runs on the same board and shares its memory, so we do what
// MAME's notes describe: set the game up, run the set chip on the same saved memory, pick a denomination with jackpot reset,
// store it with the test switch, and hand the memory back to the game (which then recovers its CMOS).
'use strict';
(function () {
function makeSetChipNV(PEPlus, gameRoms, setRoms, opts) {
  opts = opts || {};
  const run = (m, n) => { for (let i = 0; i < n; i++) m.runFrame(); };
  const g = new PEPlus(gameRoms); g.startAutoSetup(opts.mode); while (g.setupBusy) g.runFrame(); run(g, 600);
  const s = new PEPlus(setRoms); s.setNV(g.getNV()); run(s, 900);
  // selection order after power-up: 5c, 10c, 25c, 50c, $1, $2, $5 ...  (25c = three presses)
  for (let i = 0; i < (opts.presses || 3); i++) { s.press('jackpot', true); run(s, 20); s.press('jackpot', false); run(s, 100); }
  s.setDoor(true); run(s, 100); s.press('test', true); run(s, 30); s.press('test', false); run(s, 300); s.setDoor(false); run(s, 200);
  return s.getNV();
}
if (typeof module !== 'undefined') module.exports = { makeSetChipNV }; else window.PESetChip = { makeSetChipNV };
})();
