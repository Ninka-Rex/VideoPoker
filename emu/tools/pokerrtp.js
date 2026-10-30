// Exact return-to-player of a video poker pay table under optimal play (max coins).
//   node pokerrtp.js            prints the table for every game in paytables.js
// Method: for every 5-card hand H and every hold S, the expected pay is
//   sum over T subset of (H minus S) of (-1)^|T| * F[S u T]  /  C(N-5, 5-|S|)
// where F[A] = total pay of all 5-card hands containing A (inclusion-exclusion over the discarded cards, so
// the draws never have to be enumerated).  The best hold per hand is averaged over all C(N,5) hands.
'use strict';
const C = Array.from({ length: 60 }, () => new Array(7).fill(0));
for (let n = 0; n < 60; n++) { C[n][0] = 1; for (let k = 1; k <= 6; k++) C[n][k] = n ? C[n - 1][k - 1] + C[n - 1][k] : 0; }

// ---- hand evaluators: return pay per coin at max coins ----
const win = [[12, 0, 1, 2, 3]]; for (let s = 0; s <= 8; s++) win.push([s, s + 1, s + 2, s + 3, s + 4]);
function isStraight(ranks) {            // ranks: 5 distinct rank numbers
  let m = 0; for (const r of ranks) m |= 1 << r;
  for (const w of win) { let wm = 0; for (const r of w) wm |= 1 << r; if (m === wm) return true; }
  return false;
}
function fitsWindow(ranks, royalOnly) {  // natural cards (distinct ranks) can be completed to a straight with wilds
  let m = 0; for (const r of ranks) m |= 1 << r;
  for (let i = royalOnly ? 9 : 0; i < win.length; i++) { let wm = 0; for (const r of win[i]) wm |= 1 << r; if ((m & ~wm) === 0) return true; }
  return false;
}
function noWild(spec) {
  const p = spec.pays;
  return cards => {
    const rk = [0, 0, 0, 0, 0], st = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) { rk[i] = cards[i] % 13; st[i] = (cards[i] / 13) | 0; }
    const cnt = new Array(13).fill(0); for (const r of rk) cnt[r]++;
    let max = 0, pairs = 0, q = -1, t = -1; const pr = [];
    for (let r = 0; r < 13; r++) { if (cnt[r] > max) max = cnt[r]; if (cnt[r] === 2) { pairs++; pr.push(r); } if (cnt[r] === 3) t = r; if (cnt[r] === 4) q = r; }
    const flush = st[0] === st[1] && st[0] === st[2] && st[0] === st[3] && st[0] === st[4];
    const straight = max === 1 && isStraight(rk);
    if (straight && flush) { let m = 0; for (const r of rk) m |= 1 << r; return m === 0x1f00 ? p.rf : p.sf; }
    if (q >= 0) { let k = 0; for (let r = 0; r < 13; r++) if (cnt[r] === 1) k = r; return spec.quad(q, k); }
    if (t >= 0 && pairs === 1) return p.fh;
    if (flush) return p.fl;
    if (straight) return p.st;
    if (t >= 0) return p.tk;
    if (pairs === 2) return p.tp;
    if (pairs === 1 && pr[0] >= spec.pairMin) return p.pair;
    return 0;
  };
}
// wilds: set of cards that are wild (deuces, or jokers = card ids >= 52)
function wild(spec) {
  const p = spec.pays, isW = spec.isWild;
  return cards => {
    const nat = [], suits = []; let w = 0;
    for (const c of cards) { if (isW(c)) w++; else { nat.push(c % 13); suits.push((c / 13) | 0); } }
    const cnt = new Array(13).fill(0); for (const r of nat) cnt[r]++;
    let max = 0, pairs = 0, trip = 0; for (let r = 0; r < 13; r++) { if (cnt[r] > max) max = cnt[r]; if (cnt[r] === 2) pairs++; if (cnt[r] === 3) trip++; }
    const distinct = max <= 1, flush = suits.every(s => s === suits[0]);
    if (w === 0 && flush && distinct && fitsWindow(nat, true)) return p.rf;
    if (w >= 4 && spec.fourWild) return p.fourWild;
    if (w >= 1 && flush && distinct && fitsWindow(nat, true)) return p.wrf;
    if (w + max >= 5) return p.fiveK;
    if (flush && distinct && fitsWindow(nat, false)) return p.sf;
    if (w + max >= 4) return p.fourK;
    if ((w === 0 && trip === 1 && pairs === 1) || (w === 1 && pairs === 2)) return p.fh;
    if (flush) return p.fl;
    if (distinct && fitsWindow(nat, false)) return p.st;
    if (w + max >= 3) return p.tk;
    if (p.tp && (pairs === 2 || (w >= 1 && false))) return p.tp;
    return 0;
  };
}

function build(spec) {
  const N = spec.deck, evalHand = spec.wild ? wild(spec) : noWild(spec);
  const nHands = C[N][5];
  const F = [1, 2, 3, 4, 5].map(k => new Float64Array(C[N][k]));   // F[k-1][rank of k-subset]
  const F0 = [0], hand = [0, 0, 0, 0, 0];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) for (let c = b + 1; c < N; c++) for (let d = c + 1; d < N; d++) for (let e = d + 1; e < N; e++) {
    hand[0] = a; hand[1] = b; hand[2] = c; hand[3] = d; hand[4] = e;
    const pay = evalHand(hand);
    F0[0] += pay;
    for (let m = 1; m < 32; m++) {
      let k = 0, r = 0;
      for (let i = 0; i < 5; i++) if (m >> i & 1) { k++; r += C[hand[i]][k]; }
      F[k - 1][r] += pay;
    }
  }
  const denom = [1, 2, 3, 4, 5].map(k => C[N - 5][5 - k]); denom.unshift(C[N - 5][5]);
  const PC = new Uint8Array(32); for (let i = 1; i < 32; i++) PC[i] = PC[i >> 1] + (i & 1);
  const idxSub = new Int32Array(32), ev = new Float64Array(32);
  // expected pay of each hold mask for a sorted hand (fills ev); returns best
  const holds = hand5 => {
    for (let m = 1; m < 32; m++) { let k = 0, r = 0; for (let i = 0; i < 5; i++) if (m >> i & 1) { k++; r += C[hand5[i]][k]; } idxSub[m] = r; }
    let best = 0;
    for (let s = 0; s < 32; s++) {
      const x = 31 & ~s; let sum = 0;
      for (let t = x; ; t = (t - 1) & x) {
        const m = s | t, k = PC[m];
        const v = k === 0 ? F0[0] : F[k - 1][idxSub[m]];
        sum += (PC[t] & 1) ? -v : v;
        if (t === 0) break;
      }
      ev[s] = sum / denom[PC[s]];
      if (ev[s] > best) best = ev[s];
    }
    return best;
  };
  return { N, nHands, holds, ev, evalHand };
}
function rtp(spec) {
  const M = build(spec), N = M.N, hand = [0, 0, 0, 0, 0];
  let total = 0;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) for (let c = b + 1; c < N; c++) for (let d = c + 1; d < N; d++) for (let e = d + 1; e < N; e++) {
    hand[0] = a; hand[1] = b; hand[2] = c; hand[3] = d; hand[4] = e;
    total += M.holds(hand);
  }
  return total / M.nHands;     // pays are per coin, so this is return per coin wagered
}
module.exports = { rtp, build, noWild, wild };

if (require.main === module) {
  const games = require('./paytable_specs.js');
  for (const [name, spec] of Object.entries(games)) {
    if (process.argv[2] && !name.includes(process.argv[2])) continue;
    const t = Date.now(); const r = rtp(spec);
    console.log(name.padEnd(28), (r * 100).toFixed(4) + '%', ((Date.now() - t) / 1000).toFixed(1) + 's');
  }
}
