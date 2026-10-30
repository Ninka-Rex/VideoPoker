# Notes: reverse engineering IGT Game King (i960) ROMs

Written after getting gkigt4 (folder "Game King (v4.x)") (G0001777 / M0000527) from raw ROMs to a playable browser emulator.
These notes are for doing the next set faster.

## 0\. Ground rules learned the hard way

* **MAME's driver is a map, not the truth.** gkigt.cpp gets the memory map right, but several devices are wrong or missing:

  * the QUART register layout
  * the raster register encoding
  * which address the sound chip sits at
  * IAC reinit and software interrupts
  * the tile bank bit
  * the NVRAM size

  Use it for addresses, then verify every device against the firmware's own code.

* **The firmware is the best documentation.** It has a diagnostic serial port, assert strings with source file names, an event log with human-readable names, and an input-test screen. Get the diagnostic output working first.
* **Save states early.** Once boot takes \~1,400 frames, iterating from cold costs minutes per experiment. Snapshot everything: CPU, all RAM, devices, and small plain objects like door state. That last one burned me once.

## 1\. Loading the ROMs

|Chip|Address|Notes|
|-|-|-|
|`m000xxxx base`|`0x00000000`|Config/paytables, plus the i960 IMI at offset 0 (SAT, PRCB, check, first IP).|
|`g000xxxx gme1/gme2`|`0x08000000`|Program code. Byte-interleaved: gme1 even, gme2 odd. Little-endian.|
|`c000xxxx plx1/plx2`|`0x08200000`|Bitmap graphics, interleaved the same way. The CPU blits these into VRAM itself.|
|`c000xxxx cg1/cg2`|none|Tile ROM, not CPU-mapped. 4×4 tiles, 4bpp, 8 bytes each; pixel 0 is the low nibble. Interleave cg1/cg2.|
|`swc000xx snd`|`0x3b000000`|YMZ280B samples. Only used with the Multimedia sound board; gkigt4 doesn't use it.|

Match sets to MAME by CRC32 before anything else (`gkigt.cpp` `ROM\_START` blocks).

## 2\. Ghidra

* The processor module is at `ghidra\_i960\\` (installed into `Ghidra\\Processors\\i960`). Language `i960:LE:32:KB`.
* Project setup: `ghidra\_i960\_scripts\\setup\_gameking.py` (pre-script), then auto-analysis, then `fixups.py` (post-script). Headless is driven with `analyzeHeadless.bat`.
* **JDK 25 breaks Ghidra 11.3 Java scripts** (OSGi `osgi.ee=UNKNOWN`). Use Python (Jython) scripts, or install JDK 21.
* **Don't wrap `analyzeHeadless.bat` in `timeout`**, and don't pass args containing `%` or spaces. The batch quoting breaks. Pass lists through a file (`@file` in report.py).
* **Leaf functions return through a register.** `bal` puts the return address in g14; the callee copies it (`mov g14,gN` or `lda (g14),gN`), zeroes g14, and returns with `bx (gN)`. Mark those as RETURN flow overrides, or every leaf function ends in "UNRECOVERED\_JUMPTABLE".
* **Function discovery:** seed from direct call targets that have 2 or more callers. Then try the first non-zero word after every return, then wrap orphan code. That took coverage from about 2,900 to 6,350 functions.
* **The "system procedure table" at SAT+152 is only the first 28 entries** of a larger .data block. The boot code copies 0x2dc0 bytes from ROM 0x081fcfc0 to RAM 0x10000020. Map that block pre-filled in Ghidra so globals show their initial values.
* **Ignore oversized stack arrays** (`\[999680]`) in decompiler output. It's a quirk of the upward-growing stack.
* `emu\\decomp.sh out.txt <addr|str:TEXT> ...` decompiles from the existing project in about 30 s. Finding code by string is the fastest way in: error strings, event names, UI prompts.

### Fast static tricks (no Ghidra needed)

`scratchpad\\i960dis.py` is a Python port of MAME's disassembler, with a memory model.

* **Find callers:** scan every word for CTRL `call`/`bal`/`b` (opcode 0x08–0x0b) and compute targets.
* **Find code using a constant or address:** look for MEMB mode 0xc (`(w>>10)\&15 == 0xc`) whose next word is the value, or MEMA `lda` with a 12-bit offset (`w\&0xfff`).
* **Event codes** go through `lda 0xNNN,gX` before `call 0x08054df0` (the event logger). Error codes are negative constants passed to `0x080340e0` (system\_error) or `0x08034320` (cmos\_error).

## 3\. CPU (i960KA/KB) gotchas

* **IAC messages** are `synmovq` to 0xff000010:

  * `0x40nn0000` posts **software interrupt nn**. The OS scheduler uses vector 16. MAME ignores this.
  * `0x93` **reinitializes the processor**: priority 31, supervisor mode, fresh interrupt stack from PRCB+24. MAME only changes IP, which is why MAME hangs on soft reset.
* **ICR:** `synmov` to 0xff000004 loads the interrupt control register (vector per external IRQ line).
* **PRCB layout as used:** +20 interrupt table, +24 interrupt stack, +40 fault table.
* I write local registers to the frame on every call and read them back on every ret (no register cache). It's simpler, and fine for this firmware.

## 4\. Game King hardware, as the firmware uses it

* **QUART (SC28C94) ×2:** at 0x28010000 and 0x28040000. Registers sit on byte lanes 0 and 2, so `reg = (off>>2)\*2 + ((off>>1)\&1)`.

  * Per block: +4 IPCR/ACR, +5 ISR/IMR, +6/7 counter, +0xc output port, +0xd input port, +0xe/f start/stop counter.
  * Writing 0x2a means "update CIR"; reading 0x28 returns CIR, coded as `type<<2 | channel` (1 input change, 2 Tx, 3 Rx, 4 break, 5 counter). The ISR loops until CIR is 0, so the stub must return 0 eventually.
  * Timers: QUART1 counter at about 400 Hz, QUART2 at about 2 kHz. Both go to vector 24.
  * **Output port pins are inverted** relative to the register.
* **Diag serial:** QUART1 channel D. Capture it from the first run; it prints boot progress, CRCs, memory maps and every event.
* **SENET (0x28020000):**

  * 0x40–0x7c: lamp/meter latches (read-modify-write)
  * 0x28–0x32: switch inputs
  * 0x1fa/0x1fc: I²C controller (bit0 go/busy, bit1 stop, bit2 read transaction; a zero low nibble starts a new transfer) to a 24C16 EEPROM at 0xA0
* **DS2401 serial number:** bit-banged 1-Wire. Driven by QUART1 port B output bit 6 (1 pulls the line low), read on input bit 7. The command is 0x0F; CRC-8 is the Dallas one, seeded via family code 0x01.
* **Raster register 0x18200000** = `line << 3` (readers use `(v>>3)\&0x1fe`). With MAME's raw vpos, every screen that waits for a scanline hangs.
* **Video:** 8bpp bitmap at 0x18000000 (1024 bytes per line, colour 0 transparent) over a tilemap at 0x18100000 (256×128 entries). Each tile entry is decoded as:

  * tile index = bits 0–11, plus bits 16–20 as index bits 12–16 (**bit 20 = upper CG half**, which MAME misses)
  * colour bank = bits 24–27
  * The RAMDAC is at 0x28060000/2/4 (index, RGB666 data, mask).
* **NVRAM is 512 KB** (0x10000000–0x1007ffff); MAME maps 128 KB. The boot log prints the layout (terminal meters, terminal data, game meters, game data, progressives). Persist all of it, or game select fails with "CORRUPTED RAM".
* **Doors are strobed:** a closed door echoes QUART2 port-A output bit 1, read on port B bits 0–2. A static level always looks open or tampered.
* **Line frequency:** a 60 Hz square wave on QUART1 port A input bit 2. *Not* SENET 0x30 bit 5, which is the hopper coin-out optic; toggling that pays out phantom coins.
* **Coin acceptor:** valid-coin pulse (0x2a bit 4), then optic A (bit 2) blocks, then B (bit 3) blocks, A clears, B clears. Optics without the pulse count as "coin in string" (cheating).
* **Panel buttons:** `0x28` bits 0–4 hold 1–5, bit 6 deal/draw, bit 7 cash out; `0x2a` bit 0 bet max, bit 1 bet one. All active high.
* **Netplex peripheral bus:** QUART2 channel A, multidrop.

  * Host polls with `\[addr, 00]`; packets are `\[addr, type, len, payload, crc16]` with CRC-16/KERMIT (little-endian).
  * The touch screen is device 3 and reports in screen pixels. Type 0x10 is a touch report: 4 bytes per point (event nibble 1 down, 2 drag, 3 lift; 12-bit X; 16-bit Y). Game screens need drag reports while the finger is held.
  * Devices 4 and 6 (bill validator, printer?) can stay silent.
* **Sound:** **YM2413 (OPLL) at 0x28050000** (register select / data). The 0x28000000 address MAME gives it is unused here. The YMZ280B is only on the optional Multimedia board.

## 5\. Bring-up order that worked

1. CPU core, then boot until the diag serial prints. Check that the ROM CRCs it prints match.
2. QUART interrupt arbiter, timers, and IAC software interrupts and reinit.
3. Follow the error screens; each one names its subsystem:

   * **CMOS init:** main door open, turn the key twice, then hold the test switch 2–3 s.
   * **EEPROM:** emulate the I²C protocol from the firmware's own read/write routines.
   * **Serial number ROM:** the DS2401.
4. Operator menu: emulate touch (device 3), then fix the raster register when menus hang.
5. **Probe inputs automatically:** flip each bit from a saved state and diff the event log and screen. Do it in the right context (idle for bet buttons, mid-hand for hold/draw).
6. **Operator setup:** with the door open, the test switch enters the menu. Then Setup → Machine Options → Game Denom Setup (CHANGE, SAVE, EXIT, restart). After returning to the game, acknowledge "VERIFY ALL OPTIONS" OK.
7. Ship the resulting 512 KB CMOS + EEPROM as the default image.

## 6\. Next time / open items

* **Other sets** (gkigt43, gkigt43n, gkigt4ms, gkigt5p, gkigtez): same board. Expect identical devices, but **addresses inside the program change**, so re-find routines by string or constant rather than reusing addresses. Check the CRCs first.
* **Remaining work:**

  * rhythm section of the YM2413
  * bill validator / printer on Netplex
  * exact CPU timing (currently about 2 cycles per instruction)
  * the YMZ280B for Multimedia-board sets



\---

# Part 2: the 8-bit boards (Player's Edge Plus, Draw 80) and more Game King sets

Written after adding `mcs51.js` / `peplus.js` (80C32), `mcs48.js` / `draw80.js` (8039) and the other Game King sets.

## 7\. Which CPU is which

|Machine|CPU|Notes|
|-|-|-|
|Game King (all gkigt sets)|i960KA/KB|covered above|
|Player's Edge, Player's Edge Plus (PK/PP/BE/PS/MG programs)|**80C32** (8052 core)|6545 CRTC, AY-3-8912, X2404P EEPROM|
|Draw 80 Poker (1982/83)|**8039** (MCS-48, *not* an 8052)|6845 CRTC, AY-3-8912, two 4 KB program banks|

Ghidra already ships an 8051 module (`8051:BE:16:default`), so no new processor definition was needed.
`ghidra\_8051\\analyze.sh <name>` imports `inputs\\<name>.bin` (raw, base 0), seeds the 7 interrupt vectors, runs
auto-analysis, labels the I/O addresses and writes every function's decompiled C to `out\\<name>.c`.
Output is readable straight away (330–500 functions per ROM, no "bad instruction" problems).
Ghidra has no MCS-48 module; Draw 80 was done from MAME's driver and the firmware's own behaviour.

## 8\. Player's Edge (Plus) board

* Program ROM is 64 KB (Plus) or 32 KB mirrored into both halves (original board). CG graphics are four 32 KB (or 16 KB)
bit-plane ROMs, **plane order is reversed**: pixel = `mx<<3 | mb<<2 | mg<<1 | mr` (MAME's `gfx\_8x8x4\_planar`).
* The colour PROM is inverted: R = bits 0–2, G = bits 3–5, B = bits 6–7, weights 0x97/0x47/0x21, value = `\~prom`.
* **Video RAM is written through the 6545's transparent-addressing port** (`MOVX @DPTR` to 0x2083). The *tile attributes
come from 80C32 ports P1 and P3 at the moment of the write* (P1 low nibble = tile bank bits, high nibble = colour).
* xdata map: `0000-1FFF` battery CMOS · `2080/2081/2083` CRTC · `4000/4004` AY address/data (and DIP SW1 read) ·
`6000` background-colour latch · `8000` input bank A (r) / output C (w) · `9000` I²C EEPROM (SCL bit2, SDA-direction
bit1, SDA bit0) · `A000` inputs (r) / output B (w) · `C000` output A · `E000` DUART (SAS + ticket printer).
* Vertical sync drives INT0. The CRTC status register's bit 7 is "update ready".
* **Door switch is a toggling strobe on Plus boards** (it must change state every 500 cycles to read as closed); the
original non-Plus board uses a static level. Same idea as Game King's strobed doors.
* Coin acceptor: optic code sequence A, AB, ABC, BC, C (about 10 000 cycles per step).
* Bill validator pulses (ID-022 / ID-023) are ported from MAME's driver but untested here.
* **Operator initialisation differs by board**: Plus boards show "CMOS DATA" with the door open (test switch), then
"EEPROM DATA" (test switch again), then close the door. The non-Plus board shows "BAD DATA MEMORY" and needs the door
opened and one test press. Montana Choice first asks to recover CMOS (press **jackpot reset**), then EEPROM data.
The page does the right sequence by itself on the first run (`PEPlus.startAutoSetup`).
* AY-3-8912: one tick = **8** chip clocks; a tone toggles every `period` ticks. (First attempt used 16 and sounded an
octave low and far too slow.)

### Montana Choice (MG0225): printer, progressive link, coins

Now boots to the keno screen, takes coins and bets. Three things were missing, all found in `ghidra\_8051\\out\\pe\_montana\_mg0225.lst`
(full disassembly; written by `scripts\\pe\_listing.py`, because Ghidra's C for the interrupt handlers is unreadable):

* **Ticket printer = DUART channel B, interrupt driven.** The firmware *does* read the DUART, but only inside INT1 (vector 0x13):
IMR = 0x20 enables "RxRDYB", and the handler reads ISR (0xE005) and RHRB (0xE00B). Its reply state machine sits at 0x3ADD
(state in xdata 0x033D). The printer answers each control byte with **ACK (06)**. After **DC3 (13)** the next ENQ (05) is
answered with a status digit instead, **'0' = ready** ('6'/'7' = other states, NAK 15 = error). Without replies it retries
ENQ, then DC1 twice, then shows PRINTER ERROR. Ticket text follows; byte 0x15 ends a ticket. Door-access audit slips
print on every door open (that was the 1.3 KB "YOUR ESTABLISHMENT…" output).
* **Progressive link = the 80C32 serial port** (mode 3, about 2400 baud, receive only). The level count is hard-wired: the mask
0x0F at 0x5AF0 gives 4 levels (xdata 0x0EC8), so the link check can't be switched off. The controller broadcasts one
8-byte packet per level: `0xNF` (N = level), one BCD digit, four BCD bytes (cents, most significant first), `00 00`.
The power-up test (0x9283) passes when the top level (count−1) shows up consistently over three listening windows. At
run time (0x934B) each level is checked against the ROM minimums at 0x01E8 ($55, $500, $400, $200); missing packets
count down to LINK DOWN. `PEPlus.linkTick()` plays the controller for `mg\*` programs.
* **Coins are single-pulse here.** With flag bit 0x31 set (it is, for this program) the coin routine at 0x826A accepts
only optic B going active (raw 0x02) and calls anything else held for 10 ticks a fault ("COIN-IN TIMEOUT"). The
normal A/AB/ABC/BC/C sequence is wrong for it. `PEPlus.coinPulse`.
* **Still open: picking keno numbers.** The keno screen says "PICK NUMBERS"; none of the panel buttons pick, and the
firmware never reads the CRTC light-pen registers (MAME's keno touchscreen), so the touch input is somewhere not
found yet.

## 9\. Draw 80 Poker

* 8039 at 8 MHz (1 machine cycle = 15 clocks), program memory = two 4 KB banks. **Every expander instruction
(MOVD/ANLD/ORLD) pulses PROG and the driver toggles the ROM bank on the rising edge.** That is how the game
switches banks.
* All I/O is `MOVX` with the *meaning decided by port values*: P2 selects the device (0x3F low VRAM byte, 0x7F colour +
high VRAM bits, 0xC7/0xD7 CRTC address/data, 0xFB battery RAM, 0xFF = P1-decoded group: 0xF7 meters+hopper,
0xEF lamps, 0xFC/0xFE AY, 0xDF attract). P1's top two bits extend the VRAM offset.
* Screen is 24×27 tiles of 8×8, 2 bpp (two 4 KB ROMs, plane 0 = `cg0`). Colour comes from a 256-byte PROM (`cap13`).
* Inputs are *encoded*: reading group 0xF7 returns 0x80 + (key number), group 0xEF returns coin/keyout codes.
* DIP switch SW1 is read through AY port A.

## 10\. Game King: other sets

* File → chip mapping lives in `gkroms.js` (derived from MAME's `gkigt.cpp`): `gkigt4ms`, `gkigtez`, `gkigtezms`
reuse the base/graphics of `c000351` / `m000526` and the game ROM of another set, so files must be found by name
anywhere under the ROM folder.
* **The later firmware needs more battery RAM than v4.0.** With 512 KB, v4.3 and the others run but fail a cold boot with
"CRITICAL DATA ERROR" / "CONFIG CHECKSUM ERROR"; persisting 1 MB fixes it. `gkroms.nvSize()` returns 1 MB for
everything except `gkigt4`. Always test a saved NV by cold-booting it (`gk\_run.js <set> 2400 out.png nv/<set>.nv`).
* A saved NV only works with the config ROM it was made with ("CONFIGURATION EPROM CRC MISMATCH" otherwise), so every
set gets its own `nv\\<set>.nv` from `gk\_provision.js`.
* The operator menus move between sets: the *Game Denom Setup* button is at (266,118), (266,70) or (370,142) depending
on the set; the *CHANGE* button at (253,289) or (253,256). `gk\_provision.js` has the table.
* **Triple-Five Play's bill validator (Netplex device 4) — fixed.** Driver at 0x08004330 in program g0001783 is a
20-state machine (state at 0x10003AFC; per-state handlers in a table at 0x080043A8; reply type = byte 1 \& 0x3F). Found by
making device 4 answer with a marked packet, watching where the bytes landed (0x10009790), and following the readers.
Protocol: the host sends a command, the device **echoes it immediately** (empty packet, same type); the host then sends
**0x01**, stops listening, and collects the actual result **at the next poll**. Answering 0x01 straight away collides with the
next frame (that was the original "Comm Failure"). Results: type 0x01 for most commands; the signature request
0xE2/0xA2 (seed in payload bytes 4–5) wants type **0x23** + 16 bits. Boot sequence: 2F, 74 (ff f1 ff), B1, E2, 42, then
idle in state 15. Idle reply types: 0x31 bill in escrow, 0x33 stacked, 0x32 error/status, 0x30 busy (bill insertion
not modelled yet). The tilt latched in the old saved NV, so `nv\\gkigt5p.nv` was re-provisioned with the validator present
(the page's storage key for this set is versioned so browsers pick up the new one).
* Also fixed in the bus model: replies queue behind each other instead of interleaving (`QUART.receive`).
* **gkigt4 bills were refused — fixed.** Two causes. (1) The page booted gkigt4 from the old `configured.nv`, made before
the bill validator existed, so the firmware never polls Netplex device 4. (2) `nv/gkigt4.nv` was provisioned with the
default menu positions; on this firmware (266,118) is *Mainmenu Backgnd Color*, so no denomination was set and the
machine sat in "Operator Must Set Denomination" and returned every bill (0x33). gkigt4 uses the v4.0 positions
(Game Denom Setup at (266,70), CHANGE at (253,256)) like gkigt4ms. The page now ships `nv/gkigt4.nv` like every other
set. Validator boot here: 2F 34 30 31 22 01 02 30; a bill is stacked (0x32).
* **Ticket in on the v4.0 sets (gkigt4, gkigt4ms, gkigtez, gkigtezms) — fixed.** SAS never answered because the machines had
no SAS address (tickets printed "MACHINE# 0"). On v4.0 firmware the IGT SAS button under Comm Options is at (266,166),
not (266,214): the old taps opened Bally protocol setup and Game Options instead. `gk\_provision.js` takes it per set
(`sas: 166`); SAS Primary is on comm channel 2 there, as on the later sets. Page storage keys for these sets are v3.

## 11\. Game King hopper (coin-out jams) — fixed

Symptom: cash-out ended in a "Coin out jam" tilt. The payout state machine (`0x0805c8c0`) turns the hopper motor on by
setting **SENET latch 0x70 bit 1** (`0x0805d1c8`), then expects the coin-out optic (**SENET input 0x30 bit 5**, read via
`0x0805c480`) to go high within 750 ticks and then low again, once per coin; if not it retries in reverse and finally
raises event 0xF03 / 0x502. The emulator now generates that signal while the motor bit is set: first coin after 150 ms,
then a 50 ms pulse every 100 ms (`SENET.hopperOptic`). A 4-coin cash-out completes with "Hopper cashout done".

## 12\. Workflow that worked for the new boards

1. Read MAME's driver for the memory map and input encodings, port it to JS, and get *something* on screen first.
2. Look at the firmware's first error screen, then follow MAME's initialisation notes (they are accurate).
3. Decompile with Ghidra (`ghidra\_8051\\analyze.sh`) whenever MAME is silent about a device, and grep the C for the
register address (`DAT\_EXTMEM\_e009`, `IO\_...`).
4. Validate headless first (`pe\_run.js`, `d80\_run.js`, `gk\_run.js` write PNGs), then in Chrome:
`chrome --headless=new --virtual-time-budget=30000 --screenshot=out.png <url>`.

### Superboard sets (`New ROMs/newer`: X000002P/X000006P + XP0000xx)

* `xp0000xx.u67` is the 64 KB main program; `x0000xxp.u66` is a "Superboard data" ROM that MAME copies into six 4 KB RAM windows
(xdata 0x3000, 0x5000, 0x7000, 0xB000, 0xD000, 0xF000) at power-on (`load\_superdata`). Without it the game shows
"INCOMPATIBLE DATA EPROM". Colour PROM is `capx1321.u43` (name matches `cap\[x\\d]`). `pex0002pa` keeps its own CG set in a subfolder.
* Initialisation (found by tracing the CMOS-error loop at 0xCFE4–0xD036): the test switch must be **held \~3 s** (67 × 30 timer ticks) until
the game beeps; a short tap does nothing. Then door closed, jackpot reset, door open ("EEPROM DATA"), hold test again, door closed.
`PEPlus.startAutoSetup` does this when `roms.superData` is present.

