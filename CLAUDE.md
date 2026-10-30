# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Browser emulators that run the original firmware of IGT gaming machines: Game King (Intel i960), Player's Edge / Player's Edge Plus (80C32), Draw 80 Poker (8039). The goal is fidelity to the real hardware. The emulators are written in plain JavaScript with no build step and no test suite; the code that matters is in `emu/`. The rest of the folder is supporting material (ROMs, MAME checkout, Ghidra projects, notes, scratch output).

Read `NOTES-igt-reverse-engineering.md` before touching a device model. It records what MAME gets wrong, how each device was verified against the firmware, and the reverse-engineering procedure. `emu/README.md` documents the user-facing features.

## Commands

All from `emu/` (Node.js, no npm packages):

- Play: open `emu/index.html` directly from disk (no server). `Play Game King.bat` does the same.
- **After adding or changing ROMs or `emu/nv/*.nv`: `node build_bundle.js`**. Pages cannot fetch files from `file://`, so every ROM is packed into `emu/bundle/*.js` (`library.js` plus base64 data scripts loaded on demand). Stale bundle = stale site.
- `node make_previews.js` regenerates the hover screenshots in `previews/` (then rebuild the bundle). Note: do not pass a filter argument that `serve.js` could mistake for a folder; `serve.js` only reads argv when run directly.
- `node tools/make_paytables.js` regenerates `paytables.js` (pay tables transcribed in that file plus exact optimal-play returns from `tools/pokerrtp.js`, about a minute).
- `node tools/qualify.js <set folder> <setchip folder> [out.png]` boots one Player's Edge set in every set-up mode and prints which one reaches a playable screen; `tools/payout_check.js <set folder>` plays until a hopper payout and checks the game is still playable.
- `node serve.js [root] [port] [--name=x | --no-mdns]` is an optional web server (`/api/library`) that also announces `<name>.local` (default `videopoker.local`) on the LAN through `mdns.js`, a package-free mDNS responder; its scanners (`scanPE`, `scanGK`, `scanD80`, `scanSetChip`) are what `build_bundle.js` and `make_previews.js` import.
- Headless runners for debugging, all produce PNGs: `node gk_run.js <set> <frames> out.png`, `node pe_run.js <rom folder> <frames> out.png [cmds]`, `node d80_run.js <folder> <frames> out.png [cmds]`, `node run.js`, `node session.js` (save states). `node gk_provision.js <set>` performs the Game King operator set-up on a blank machine and writes `nv/<set>.nv`.

## Architecture

**One machine class per family, driven frame by frame.** `GameKing` (`gameking.js` + `devices.js` + `i960.js`), `PEPlus` (`peplus.js` + `mcs51.js`), `Draw80` (`draw80.js` + `mcs48.js`). Each exposes `runFrame()`, `render(pixels)`, `press(name, down)`, `getNV()/setNV()`, `info()` / `debugInfo()` and `onAudio`. The same classes run in Node (tests, provisioning, screenshots) and in the pages, so devices must not touch the DOM. `common.js` is the shared page layer (IndexedDB `kvGet/kvSet`, audio, `InfoPanel`, `ReceiptsPanel`, library/ROM loading from the bundle, pay-table rendering, dark-mode link).

**ROM library pipeline.** `ROMs/<family>/<set folder>/` holds complete sets (split sets were merged with their parent). `serve.js` scanners find sets by file-name patterns (`peroms.js` and `gkroms.js` hold the matching rules: program `.u58/.u68`/`xp*.u67`/`pp*_*.u67`, graphics `m?o-c[gf]*`, colour PROM `cap*`, Superboard data ROM `x*.u66`). Folders starting with `_` are skipped (set chips live in `ROMs/Player's Edge Plus/_Set chips/`). `build_bundle.js` also reads `emu/setups.json`, which records per Player's Edge program how it must be initialised (`mode`: `tap`, `hold` or `both`; `setchip`: needs IGT's set chip) plus catalog fields (`game`, `short`, `payback`, `section`). The library page and `peplus.html` consume that.

**Player's Edge first-run initialisation** is scripted in `PEPlus.startAutoSetup(mode)` (operator door + test-switch sequences; older programs need short taps, newer ones need the test switch held ~3 s). Programs that show "SET DENOMINATION" are provisioned by `pesetchip.js`, which runs the set-chip program on the game's saved memory, then `startRecover()`. Always build the NV before creating the machine the page will run, otherwise the half-booted machine races the provisioning.

**Game King** needs per-set pre-configured NV images in `nv/` (CMOS, EEPROM, denomination, and for ticket-in/out the bill validator, printer and SAS settings). `gkroms.js` is the set table (chip file patterns, keychip RAM address that unlocks operator options, `devices` for Netplex peripherals). Peripherals sit on the Netplex bus (`devices.js`: bill validator at 4, thermal printer at 2, touch at 3) and a SAS host (`sashost.js`). The i960 core runs the real firmware; devices were reverse-engineered by tracing it (see the notes, plus `ghidra_*` projects and `ghidra_8051/out/*.lst` listings).

**Player's Edge board details that are easy to get wrong** (all in `peplus.js`): I/O latches decode only the top address bits (programs use 0x802A, 0xC02A, ...); the hopper coin-out optic is read-driven with ~120 ms phases and must not restart when the output port is rewritten; the light pen (keno) latches 6545 registers 16/17 on every scan line of the pen's row and the firmware subtracts 2 from the address; the door switch on Plus boards is a toggling strobe; bill validators have several pulse protocols (`pebill.js`).

**Pay tables** are data, not code: `paytables.js` is generated. Poker returns are computed exactly by `tools/pokerrtp.js` (inclusion-exclusion over discarded cards); slot/blackjack figures come from MAME's driver notes and the payback stored in the ROM itself.

## Working conventions

- Verify device behaviour against the firmware (traces, Ghidra listings), not only MAME's `igt/peplus.cpp` / `gkigt.cpp`; the MAME source lives in `MAME/` for reference.
- Headless Chrome with `file://` URLs (virtual-time budget) is the way pages were checked; screenshots and throwaway scripts go in `scratch/`, which is not part of the product.
- Page styling is shared through `emu/theme.css` (Frutiger Aero: sky background, frosted-glass panels, glossy gel buttons, square corners, no rounded borders; Segoe UI text, no title bar by default; Istok Web is self-hosted in `emu/fonts/`); dark mode swaps CSS variables via `data-theme`. The "style" panel (`common.js`) lets you try fonts, title-bar looks (`data-bar`) and colour themes for light (`data-pl`) and dark (`data-pd`) mode.
- Keep files' existing line endings when editing: several files are CRLF or mixed, and edits made through scripts have to normalise and restore them.
