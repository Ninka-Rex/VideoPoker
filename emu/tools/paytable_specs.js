// Pay tables as read off the emulated machines' own pay-table screens (pay per coin at 5 coins bet).
'use strict';
const A = 12, K = 11, Q = 10, J = 9;                       // rank numbers: 0 = deuce ... 12 = ace
const std = (extra) => Object.assign({ rf: 800, sf: 50, fh: 9, fl: 6, st: 4, tk: 3, tp: 2, pair: 1 }, extra);
const low = r => r <= 2;                                    // 2s, 3s, 4s
const jqk = r => r >= J && r <= K;
const G = {};
const add = (name, deck, pairMin, pays, quad) => { G[name] = { deck, pairMin, pays, quad }; };

add('jacks_or_better_96', 52, J, std({}), () => 25);
add('bonus_poker_85', 52, J, std({ fh: 8, fl: 5, tp: 2 }), q => q === A ? 80 : low(q) ? 40 : 25);
add('bonus_poker_deluxe_96', 52, J, std({ tp: 1 }), () => 80);
add('double_bonus_975', 52, J, std({ fl: 7, st: 5, tp: 1 }), q => q === A ? 160 : low(q) ? 80 : 50);
add('double_double_bonus_96', 52, J, std({ fl: 6, tp: 1 }), (q, k) =>
  q === A ? (low(k) ? 400 : 160) : low(q) ? ((k === A || low(k)) ? 160 : 80) : 50);
add('triple_double_bonus_975', 52, J, std({ rf: 800, fl: 7, st: 4, tp: 1, tk: 2 }, 0), (q, k) =>
  q === A ? (low(k) ? 400 : 160) : low(q) ? ((k === A || low(k)) ? 400 : 80) : 50);
G.triple_double_bonus_975.pays.rf = 800;
add('triple_bonus_10_7', 52, K, std({ fh: 10, fl: 7, tp: 1 }), q => q === A ? 240 : low(q) ? 120 : 75);
add('triple_bonus_plus', 52, J, std({ sf: 100, fh: 9, fl: 5, tp: 1 }), q => q === A ? 240 : low(q) ? 120 : 50);
add('super_aces_8_5', 52, J, std({ sf: 60, fh: 8, fl: 5, tp: 1 }), q => q === A ? 400 : low(q) ? 80 : 50);
add('super_aces_7_5', 52, J, std({ sf: 60, fh: 7, fl: 5, tp: 1 }), q => q === A ? 400 : low(q) ? 80 : 50);
add('super_double_bonus', 52, J, std({ sf: 80, fl: 5, tp: 1 }), q => q === A ? 160 : jqk(q) ? 120 : low(q) ? 80 : 50);
add('aces_and_faces_6_5', 52, J, std({ fh: 6, fl: 5, tp: 2 }), q => q === A ? 80 : jqk(q) ? 40 : 25);
add('double_aces_faces', 52, J, std({ fh: 9, fl: 7, st: 5, tp: 1 }), q => q === A ? 160 : jqk(q) ? 80 : 50);
add('dbl_dbl_aces_faces', 52, J, std({ fh: 7, fl: 5, st: 4, tp: 1 }), (q, k) =>
  q === A ? (jqk(k) ? 400 : 160) : jqk(q) ? ((k === A || jqk(k)) ? 160 : 80) : 50);

const deuces = (wrf, fiveK) => ({ deck: 52, wild: true, fourWild: true, isWild: c => c % 13 === 0, pays: { rf: 800, fourWild: 200, wrf, fiveK, sf: 10, fourK: 4, fh: 4, fl: 3, st: 2, tk: 1 } });
G.deuces_wild_a = deuces(25, 16);
G.deuces_wild_b = deuces(20, 12);
G.joker_poker = { deck: 53, wild: true, isWild: c => c >= 52, pays: { rf: 100, fiveK: 800, wrf: 100, sf: 100, fourK: 16, fh: 8, fl: 5, st: 4, tk: 2, tp: 1 } };
G.double_joker = { deck: 54, wild: true, isWild: c => c >= 52, pays: { rf: 1000, wrf: 100, fiveK: 50, sf: 25, fourK: 10, fh: 8, fl: 6, st: 4, tk: 1, tp: 1 } };
module.exports = G;
