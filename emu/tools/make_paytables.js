// Builds ../paytables.js: the pay tables read from the machines' own screens + exact optimal-play returns.
//   node make_paytables.js        (takes about a minute: it solves every video poker table)
'use strict';
const fs = require('fs'), path = require('path');
const { rtp } = require('./pokerrtp.js');
const specs = require('./paytable_specs.js');
const R = (name, c1, c5) => [name, c1, c5 === undefined ? c1 * 5 : c5];
const RF = (c1 = 250) => R('Royal flush', c1, 4000);
const G = {
  jacks_or_better_96: { name: 'Jacks or Better', rows: [RF(), R('Straight flush', 50), R('Four of a kind', 25), R('Full house', 9), R('Flush', 6), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 2), R('Jacks or better', 1)] },
  bonus_poker_85: { name: 'Bonus Poker', rows: [RF(), R('Straight flush', 50), R('Four aces', 80), R('Four 2s, 3s, 4s', 40), R('Four 5s through kings', 25), R('Full house', 8), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 2), R('Jacks or better', 1)] },
  bonus_poker_deluxe_96: { name: 'Bonus Poker Deluxe', rows: [RF(), R('Straight flush', 50), R('Four of a kind', 80), R('Full house', 9), R('Flush', 6), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  double_bonus_975: { name: 'Double Bonus Poker', rows: [RF(), R('Straight flush', 50), R('Four aces', 160), R('Four 2s, 3s, 4s', 80), R('Four 5s through kings', 50), R('Full house', 9), R('Flush', 7), R('Straight', 5), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  double_double_bonus_96: { name: 'Double Double Bonus Poker', rows: [RF(), R('Straight flush', 50), R('Four aces with any 2, 3, 4', 400), R('Four 2s, 3s, 4s with ace, 2, 3, 4', 160), R('Four aces', 160), R('Four 2s, 3s, 4s', 80), R('Four 5s through kings', 50), R('Full house', 9), R('Flush', 6), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  triple_double_bonus_975: { name: 'Triple Double Bonus', rows: [RF(400), R('Four aces with any 2, 3, 4', 400), R('Four 2s, 3s, 4s with ace, 2, 3, 4', 400), R('Four aces', 160), R('Four 2s, 3s, 4s', 80), R('Four 5s through kings', 50), R('Straight flush', 50), R('Full house', 9), R('Flush', 7), R('Straight', 4), R('Three of a kind', 2), R('Two pair', 1), R('Jacks or better', 1)] },
  triple_bonus_10_7: { name: 'Triple Bonus Poker', rows: [RF(), R('Straight flush', 50), R('Four aces', 240), R('Four 2s, 3s, 4s', 120), R('Four 5s through kings', 75), R('Full house', 10), R('Flush', 7), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Kings or better', 1)] },
  triple_bonus_plus: { name: 'Triple Bonus Poker Plus', rows: [RF(), R('Straight flush', 100), R('Four aces', 240), R('Four 2s, 3s, 4s', 120), R('Four 5s through kings', 50), R('Full house', 9), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  super_aces_8_5: { name: 'Super Aces Bonus Poker', rows: [RF(), R('Straight flush', 60), R('Four aces', 400), R('Four 2s, 3s, 4s', 80), R('Four 5s through kings', 50), R('Full house', 8), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  super_aces_7_5: { name: 'Super Aces Bonus Poker', rows: [RF(), R('Straight flush', 60), R('Four aces', 400), R('Four 2s, 3s, 4s', 80), R('Four 5s through kings', 50), R('Full house', 7), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  super_double_bonus: { name: 'Super Double Bonus', rows: [RF(), R('Straight flush', 80), R('Four aces', 160), R('Four jacks, queens, kings', 120), R('Four 2s, 3s, 4s', 80), R('Four 5s through 10s', 50), R('Full house', 9), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  aces_and_faces_6_5: { name: 'Aces and Faces', rows: [RF(), R('Straight flush', 50), R('Four aces', 80), R('Four jacks, queens, kings', 40), R('Four 2s through 10s', 25), R('Full house', 6), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 2), R('Jacks or better', 1)] },
  ace_dollar_bonus: { name: 'Ace$ Bonus Poker', rows: [RF(), R('Straight flush', 50), R('Four aces: Ace$- or -Ace$ (special)', 250, 4000), R('Four aces', 80), R('Four 2s, 3s, 4s', 40), R('Four 5s through kings', 25), R('Full house', 7), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 2), R('Jacks or better', 1)], note: 'The special four-aces rule is not documented, so no payback is computed.' },
  double_aces_faces: { name: 'Double Aces and Faces', rows: [RF(), R('Straight flush', 50), R('Four aces', 160), R('Four jacks, queens, kings', 80), R('Four 2s through 10s', 50), R('Full house', 9), R('Flush', 7), R('Straight', 5), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  dbl_dbl_aces_faces: { name: 'Double Double Aces and Faces', rows: [RF(), R('Four aces with any J, Q, K', 400), R('Four J, Q, K with any J, Q, K, A', 160), R('Four aces', 160), R('Four jacks, queens, kings', 80), R('Four 2s through 10s', 50), R('Straight flush', 50), R('Full house', 7), R('Flush', 5), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 1), R('Jacks or better', 1)] },
  deuces_wild_a: { name: 'Deuces Wild', rows: [R('Royal flush, no deuces', 250, 4000), R('Four deuces', 200, 1000), R('Royal flush with deuce', 25), R('Five of a kind', 16), R('Straight flush', 10), R('Four of a kind', 4), R('Full house', 4), R('Flush', 3), R('Straight', 2), R('Three of a kind', 1)] },
  deuces_wild_b: { name: 'Deuces Wild', rows: [R('Royal flush, no deuces', 250, 4000), R('Four deuces', 200, 1000), R('Royal flush with deuce', 20), R('Five of a kind', 12), R('Straight flush', 10), R('Four of a kind', 4), R('Full house', 4), R('Flush', 3), R('Straight', 2), R('Three of a kind', 1)] },
  joker_poker: { name: 'Joker Poker', rows: [R('Royal flush, no wild', 100), R('Five of a kind', 400, 4000), R('Wild royal flush', 100), R('Straight flush', 100), R('Four of a kind', 16), R('Full house', 8), R('Flush', 5), R('Straight', 4), R('Three of a kind', 2), R('Two pair', 1)] },
  double_joker: { name: 'Double Joker Poker', rows: [R('Royal flush, no wild', 500, 5000), R('Wild royal flush', 100), R('Five of a kind', 50), R('Straight flush', 25), R('Four of a kind', 10), R('Full house', 8), R('Flush', 6), R('Straight', 4), R('Three of a kind', 1), R('Two pair', 1)] },
};
for (const [id, g] of Object.entries(G)) {
  if (specs[id]) { g.rtp = +(rtp(specs[id]) * 100).toFixed(2); console.log(id, g.rtp); }
}
// Player's Edge / Plus poker: pay table read off the machine (original board) or taken from MAME's PSR notes;
// the return is computed here with the same solver.
const pe = (rf, fh, fl) => ({ deck: 52, pairMin: 9, pays: { rf, sf: 50, fh, fl, st: 4, tk: 3, tp: 2, pair: 1 }, quad: () => 25 });
const peRows = (fh, fl, bonus) => [R('Royal flush', 250, bonus * 5), R('Straight flush', 50), R('Four of a kind', 25), R('Full house', fh), R('Flush', fl), R('Straight', 4), R('Three of a kind', 3), R('Two pair', 2), R('Jacks or better', 1)];
G.pe_ca = { name: 'Standard Draw Poker (CA)', rows: peRows(9, 6, 800), rtp: +(rtp(pe(800, 9, 6)) * 100).toFixed(2), note: "Read off the machine's own pay-table screen (the 4-coin column shows 1000 / 200 / 100 / 36 / 24 / 16 / 12 / 8 / 4, the 5-coin column 4000 / 250 / 125 / 45 / 30 / 20 / 15 / 10 / 5)." };
G.pe_bb = { name: 'Standard Draw Poker (BB)', rows: peRows(8, 5, 1000), rtp: +(rtp(pe(1000, 8, 5)) * 100).toFixed(2), note: "Pay table and the 1000-per-coin max-bet royal flush are from MAME's PSR notes; the payback computed here reproduces the 97.8% optimum quoted there." };
G.pe_cb = { name: 'Standard Draw Poker (CB)', rows: peRows(9, 6, 1000), rtp: +(rtp(pe(1000, 9, 6)) * 100).toFixed(2), note: "Pay table and the 1000-per-coin max-bet royal flush are from MAME's PSR notes; the payback computed here reproduces the 100.1% optimum quoted there." };
console.log('pe', G.pe_ca.rtp, G.pe_bb.rtp, G.pe_cb.rtp);

const NOTE_GK = 'Keno, slot and blackjack games on the same menu are not covered.';
const machines = [
  { match: 'gkigt5p', title: 'Game King, Triple-Five Play', games: ['jacks_or_better_96', 'bonus_poker_85', 'deuces_wild_a', 'double_bonus_975', 'double_double_bonus_96', 'super_aces_8_5'],
    note: 'Each game is offered as Triple Play (3 hands) and Five Play (5 hands); the pay table and the payback per hand are the same.' },
  { match: '^gkigt4$', title: 'Game King v4.x', games: ['deuces_wild_a', 'double_bonus_975', 'double_double_bonus_96', 'triple_bonus_plus', 'super_aces_8_5', 'super_double_bonus', 'triple_double_bonus_975'], note: NOTE_GK },
  { match: '^gkigt(4ms|ez|ezms)$', title: 'Game King v4.x Multi-Strike / EZ Pay', games: ['deuces_wild_a', 'double_bonus_975', 'double_double_bonus_96', 'triple_bonus_plus'], note: NOTE_GK },
  { match: '^gkigt43$', title: 'Game King v4.3', games: ['deuces_wild_a', 'double_bonus_975', 'bonus_poker_deluxe_96', 'double_double_bonus_96', 'super_aces_7_5', 'triple_double_bonus_975'], note: NOTE_GK },
  { match: '^gkigt43n$', title: 'Game King v4.3 New Jersey', games: ['aces_and_faces_6_5', 'ace_dollar_bonus', 'double_aces_faces', 'dbl_dbl_aces_faces', 'bonus_poker_85', 'double_bonus_975', 'double_double_bonus_96', 'triple_bonus_10_7', 'jacks_or_better_96', 'joker_poker', 'double_joker', 'deuces_wild_b'] },
  { match: 'pk0719|pepk0719', title: "Player's Edge, Standard Draw Poker", games: ['pe_ca'], note: 'Payback range quoted by IGT for this program: 95.5 to 97.5% depending on the setting, optimum 99.5%, hit frequency 45.5%.' },
  { match: 'pex0006p|X000006P', title: "Player's Edge Plus, Standard Draw Poker (X000006P)", games: ['pe_cb'], note: 'IGT-quoted range 96.1 to 98.1%, optimum 100.1%, hit frequency 45.2%.' },
  { match: 'pex0002p|X000002P', title: "Player's Edge Plus, Standard Draw Poker (X000002P)", games: ['pe_bb'], note: 'IGT-quoted range 93.8 to 95.8%, optimum 97.8%, hit frequency 45.3%.' },
  { match: 'ps0042_', title: "Player's Edge Plus, Double Diamond Slots (PS0042)", summary: 'payback 92.58%', text: 'Payback 92.58% (IGT figure, from MAME). The reel pay table is not decoded here.' },
  { match: 'peps0043', title: "Player's Edge Plus, Double Diamond Slots (PS0043)", summary: 'payback 90.10%', text: 'Payback 90.10% (IGT figure, from MAME). The reel pay table is not decoded here.' },
  { match: 'peps0298', title: "Player's Edge Plus, Double Diamond Slots (PS0298)", summary: 'payback 87.42%', text: 'Payback 87.42% (IGT figure, from MAME). The reel pay table is not decoded here.' },
  { match: 'BE0013', title: "Player's Edge Plus, Blackjack (BE0013)", summary: 'payback 98.3%', text: 'One deck, shuffled before every hand. Dealer stands on all 17s. Every win pays even money (2 for 1), blackjack included, and a push returns the bet. Six cards totalling 21 or less wins. Double on the first two cards, split pairs (split aces get one card each), insurance pays 3 for 1, surrender on the first two cards when the dealer shows no ace. Optimum-play payback 98.3% (IGT figure, from MAME).' },
  { match: 'draw 80', summary: 'no pay table shown', title: 'Draw 80 Poker', text: 'The machine never shows its pay table (it was printed on the cabinet glass) and the payouts follow the DIP switches, so none are stated.' },
  { match: 'MG0225', title: 'Montana Choice, Multi-Game', text: 'Pay tables not decoded yet.' },
];
const out = '// Generated by tools/make_paytables.js. Pay tables are what the emulated machines display; returns are exact optimal-play\n' +
  '// values computed by tools/pokerrtp.js (pay per coin at 5 coins).\nwindow.PAYTABLES = ' + JSON.stringify({ games: G, machines }, null, 1) + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'paytables.js'), out);
console.log('wrote paytables.js');
