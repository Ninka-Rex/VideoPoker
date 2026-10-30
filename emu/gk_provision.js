// node gk_provision.js <set> [out.png]: runs the operator set-up procedure on a blank machine
// (CMOS init, EEPROM init, coin denomination) and stores the result as nv/<set>.nv.
const fs = require('fs');
const { GameKing } = require('./gameking.js');
const { loadSet } = require('./gk_load.js');
const { savePNG } = require('./run.js');
const id = process.argv[2];
// the basic set-up runs without Netplex/SAS peripherals; enableTITO attaches them afterwards
const ROMS = loadSet(id), PERIPH = { billValidator: ROMS.billValidator, printer: ROMS.printer, sas: ROMS.sas };
ROMS.billValidator = ROMS.printer = ROMS.sas = false;
const m = new GameKing(ROMS); require('./devices.js')(m); m.reset();
const run = n => { for (let f = 0; f < n; f++) m.runFrame(); };
const tap = (x, y) => { m.touch.touch(1, x, y); run(8); m.touch.touch(3, x, y); run(60); };
const keyTwice = () => { for (let i = 0; i < 2; i++) { m.setSwitch('key', true); run(20); m.setSwitch('key', false); run(20); } };
const shot = f => savePNG(f, 640, 480, m.render(new Uint32Array(640 * 480)));
run(1800);
m.setSwitch('mainDoor', true); run(60); keyTwice(); m.setSwitch('test', true); run(200); m.setSwitch('test', false); run(1900);
keyTwice(); m.setSwitch('test', true); run(200); m.setSwitch('test', false); run(2500);
m.setSwitch('test', true); run(30); m.setSwitch('test', false); run(200);
if (process.env.STOP) { fs.writeFileSync(process.env.STOP, require('v8').serialize(m.saveState())); shot(process.argv[3] || 'stop.png'); process.exit(0); }
const UI = { gkigt4: [70, 256], gkigt4ms: [70, 256], gkigtez: [70, 256], gkigtezms: [70, 256], gkigt5p: [118, 289, 370, 142] }[id] || [118, 289];
tap(50, 262); tap(158, 70); if (UI[2]) tap(UI[2], UI[3]); else tap(266, UI[0]);
for (let i = 0; i < 5; i++) tap(253, UI[1]);
tap(565, 68); run(100); tap(595, 454); run(200); tap(320, 246); run(2500);
m.setSwitch('mainDoor', false); run(300); tap(307, 297); run(300);
if (process.env.SAVESTATE) fs.writeFileSync(process.env.SAVESTATE, require('v8').serialize(m.saveState()));
// Per-set extra operator steps after the basic set-up. Options behind gray buttons need IGT's keychip (a
// special EPROM in the base socket); the firmware only checks the keychip-type word at 0x100154F0, so it
// is set for the duration of these steps and cleared again before the NV is saved.
// Ticket in / ticket out: enable the voucher printer, give the machine SAS address 1 and switch validation to
// ENHANCED (STANDARD cannot redeem vouchers). Positions differ per firmware: ui.cashout = the Cashout Devices
// button under Setup > Machine Options, ui.autoconfig = Netplex Auto Config (sets that detect the bill
// validator that way instead of having it in their default options), ui.sas = height of the IGT SAS button under
// Comm Options (214 by default; 166 on v4.0 firmware, which has no extra comm protocols above it).
const { SETS } = require('./gkroms.js');
function enableTITO(ui) {
  const KEYCHIP = SETS[id].keychip, SAS = ui.sas || 214;
  m.attachPeripherals(PERIPH);
  const shotIf = n => { if (process.env.SHOTS) shot('prov_' + id + '_' + n + '.png'); };
  m.setSwitch('mainDoor', true); run(60); m.setSwitch('test', true); run(30); m.setSwitch('test', false); run(120);
  m.cpu.wr16(KEYCHIP, 1);
  tap(50, 262); tap(158, 70);
  if (ui.autoconfig) {   // the menu changes once a bill validator is installed: open it again
    tap(...ui.autoconfig); tap(552, 382); run(600); shotIf('autoconf'); tap(595, 454); run(120); tap(50, 262); tap(158, 70);
  }
  tap(...ui.cashout); tap(147, 86); shotIf('printer'); tap(595, 454); run(60); tap(280, 232); run(200);
  // Comm Options > IGT SAS > Primary Channel > Set Machine Address: 1
  tap(158, 22); tap(266, SAS); tap(374, 22); tap(482, 22); tap(50, 70); tap(570, 44); run(60); shotIf('sasaddr');
  tap(595, 454); run(60); tap(280, 232); run(200);
  // IGT SAS > Validation Setup > Validation mode: ENHANCED
  tap(158, 22); tap(266, SAS); tap(374, 166); tap(147, 126); tap(570, 44); run(60); shotIf('validation');
  tap(595, 454); run(60); tap(280, 232); run(200);
  m.cpu.wr16(KEYCHIP, 0);
  tap(50, 455); run(60); m.setSwitch('mainDoor', false); run(600);
}
const EXTRA = {
  gkigt5p: () => enableTITO({ cashout: [266, 70] }),
  gkigt43: () => enableTITO({ cashout: [370, 46], autoconfig: [370, 238] }),
  gkigt43n: () => enableTITO({ cashout: [370, 46], autoconfig: [370, 236] }),
  gkigt4: () => enableTITO({ cashout: [370, 190], autoconfig: [268, 166], sas: 166 }),
  gkigt4ms: () => enableTITO({ cashout: [370, 190], autoconfig: [268, 166], sas: 166 }),
  gkigtez: () => enableTITO({ cashout: [370, 190], autoconfig: [268, 166], sas: 166 }),
  gkigtezms: () => enableTITO({ cashout: [370, 190], autoconfig: [268, 166], sas: 166 }),
};
if (EXTRA[id]) EXTRA[id]();
fs.mkdirSync(__dirname + '/nv', { recursive: true });
fs.writeFileSync(__dirname + '/nv/' + id + '.nv', Buffer.from(m.getNV()));
if (process.argv[3]) shot(process.argv[3]);
console.log(id, 'done; last diag:', m.diag.replace(/\r/g, '').slice(-200).replace(/\n/g, ' | '));
