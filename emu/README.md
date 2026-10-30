# IGT video poker emulators

Browser emulators that run the original firmware of several IGT machines. Everything runs from this
folder with Node.js.

## Play
Open `index.html` in the repo root (or `emu\index.html`). No server is needed: every ROM is packed into `emu/bundle/*.js` by `node build_bundle.js` (re-run it after adding ROMs or changing `emu/nv/*.nv`). The library page,
which lists every game it finds under the ROM folders:

| Family | CPU | Games found |
|---|---|---|
| **Game King** | Intel i960 | `Game King (v4.x)` and its sub-sets: v4.3, v4.3 NJ, v4.x Multi-Strike, EZ Pay (two sets), Triple-Five Play |
| **Player's Edge / Player's Edge Plus** | Intel 80C32 | everything under `New ROMs\` with a `.u58` / `.u68` program ROM, graphics (`m?o-cg*.u7?`) and a colour PROM (`cap*`) |
| **Draw 80 Poker** | Intel 8039 | `New ROMs\Draw 80 Poker (Minn) 1983` |

Below the controls every page shows emulated frames per second, speed and host load; a collapsed **debug** row
opens the frame count and the CPU's registers.

### Game King
Pre-set-up machines (CMOS, EEPROM and coin denomination done) ship in `nv\`, so each set boots straight to
its menu. **Controls:** click the screen to touch it Â· 1â€“5 hold Â· Space deal/draw Â· Q bet one Â· W bet max Â·
C coin Â· X cash out. **Operator:** D main door Â· K reset key Â· T test switch.

### Player's Edge (Plus)
The first run performs the operator initialisation by itself (door open, self-test, self-test, door closed),
then plays. **Controls:** 1â€“5 hold (blackjack: surrender, stand, insurance, double, split) Â· Space deal Â·
Q play credit Â· W max bet Â· X cash out Â· Y change Â· C coin Â· B bill Â· O upper door Â· K self test Â·
L jackpot reset.
Anything the machine prints on its ticket printer (Montana Choice prints audit slips when a door opens)
appears under **Receipts**, where each ticket can be saved as a .txt file.

### Draw 80 Poker
**Controls:** 1â€“5 hold Â· B bet Â· Space deal/draw Â· C coin Â· X key out. The DIP switch bank is clickable.

## Files
| File | What it is |
|---|---|
| `i960.js` | Intel 80960KA/KB core (from MAME's, with software interrupts and a full reinitialize added) |
| `gameking.js`, `devices.js`, `opll.js` | Game King machine: memory map, video, QUART/SENET/touch/coin/door/**hopper** devices, YM2413 |
| `gkroms.js`, `gk_load.js`, `gk_provision.js` | Game King ROM-set table, node loader, and the script that performs the operator set-up and writes `nv\<set>.nv` |
| `mcs51.js`, `peplus.js`, `peroms.js`, `i2cmem.js` | 80C32 core and the Player's Edge Plus board (6545 CRTC, X2404P EEPROM, door/coin/bill-validator behaviour, DUART stub) |
| `mcs48.js`, `draw80.js` | 8039 core and the Draw 80 Poker board |
| `ay8910.js` | AY-3-8912 sound chip (both Player's Edge and Draw 80) |
| `common.js` | shared page code: storage, audio output, info panel |
| `index.html`, `gameking.html`, `peplus.html`, `draw80.html` | library page and one page per family |
| `build_bundle.js` | packs all ROMs + shipped NV images into `bundle/` so pages run from disk |
| `serve.js` | optional web server (`node serve.js [folder] [port] [--name=videopoker] [--no-mdns]`); also announces `videopoker.local` on the local network so phones and other PCs can open `http://videopoker.local:8960/`; its ROM scanner is what `build_bundle.js` uses |
| `mdns.js` | the small mDNS responder behind that name (`node mdns.js [name]` runs it alone) |
| `run.js`, `session.js`, `pe_run.js`, `d80_run.js`, `gk_run.js` | headless tools: run frames, press buttons, take PNG screenshots |

## Hardware notes
See `..\NOTES-igt-reverse-engineering.md` (Game King, i960) and the 8-bit sections at its end
(Player's Edge Plus, Draw 80).

## Not done yet
- Player's Edge Plus **Montana Choice** (keno) boots, takes coins and bets, prints its audit slips and talks to an
  emulated progressive controller, but keno numbers can't be picked yet (the touch input hasn't been found).
- Game King **Triple-Five Play**: the bill validator answers and stays online, but inserting bills isn't modelled yet.
- YM2413 rhythm channels are approximate; CPU timing everywhere is approximate.

## Tickets, bills and peripherals (Game King)

- Each set in `gkroms.js` lists the Netplex peripherals it expects (`devices`: bill validator at address 4, thermal ticket printer at 2, SAS host on QUART1 ch1). `m.attachPeripherals()` wires them; `m.debugInfo()` feeds the debug panel.
- Cash-out prints a voucher (shown in the Receipts panel, saveable as .txt). A saved .txt (or the "Insert into bill acceptor" button) is read back through the SAS host (`sashost.js`: exceptions 0x67/0x68/0x3D, long polls 0x70/0x71/0x4C/0x4D, enhanced validation) and credits the machine again.
- Verified end to end (bill in, cash-out ticket, ticket back in): every Game King set. Triple-Five Play asks to confirm the cash-out on screen.
- Player's Edge Plus: bill validator (`pebill.js`), DUART printer, progressive link, drop door and coin modes are emulated (see NOTES). Montana keno number picking and game change (Erase) are still unresolved.

## ROM folders, previews, pay tables

- ROMs live under `ROMs/`: `Game King/`, `Player's Edge/`, `Player's Edge Plus/`, `Montana Choice/`, `Draw 80 Poker/`, `Unemulated/`. Keep each set's files together (graphics and colour PROMs may sit in the set's parent folder); `serve.js`'s scanner finds them.
- After adding ROMs: `node make_previews.js` (hover screenshots in `previews/`) then `node build_bundle.js`.
- `tools/make_paytables.js` regenerates `paytables.js`: pay tables as shown by the machines plus exact optimal-play returns from `tools/pokerrtp.js` (inclusion-exclusion over the discarded cards, all 2,598,960 hands; checked against 9/6 Jacks or Better = 99.54%).
- `theme.css` is the shared look; the light / dark link bottom right is in `common.js`.

## Best-of library (Player's Edge / Draw 80)

- `ROMs/` now holds one program per game: the highest-payback one that actually boots here (chosen from the 649 IGT split sets; see `IGT_sorted\_catalog.csv`). Game King sets are untouched. Lower-payback and duplicate copies that used to be here are in `IGT_sorted\_removed from site (lower or duplicate copies)`.
- Split sets were merged with their parent sets into complete folders. `tools/qualify.js` boots every program in each set-up mode, and `setups.json` records the one that works (`tap`, `hold` or `both`) and whether it needs the set chip. `build_bundle.js` adds that to the library.
- Many programs refuse to run ("SET DENOMINATION") until IGT's set chip has stored a denomination. `pesetchip.js` runs the chip (`ROMs/Player's Edge Plus/_Set chips/`) on the game's memory, picks 25c, then the game recovers its CMOS. This happens automatically on the first run of such a game.
- Not included: Imperial / Sovereign boards, Wingboard 5-in-1, Fortune I (different hardware), and games whose split sets lack graphics or colour PROMs in the download.
