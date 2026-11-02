'use strict';
// 세계 일주 보드게임 규칙 시험. 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

const fresh = (seed = 4, opts = {}) => L.newGame(L.rng(seed), { first: 0, ...opts });
const evs = (st, t) => st.events.filter((e) => e.t === t);
// 주사위를 정해 놓고 굴리기 위해 난수를 바꿔 끼운다: 첫 번째 값 a, 두 번째 값 b (1~6)
function rollWith(st, a, b) {
  const orig = st.rand; const q = [(a - 0.5) / 6, (b - 0.5) / 6];
  st.rand = () => (q.length ? q.shift() : orig());
  const ok = L.roll(st); st.rand = orig; return ok;
}
const tile = (name) => L.BOARD.findIndex((b) => b.name === name);
const give = (st, who, name, level = 0) => { const i = tile(name); st.props[i].owner = who; st.props[i].level = level; return i; };

test('the board has 32 squares: 18 cities in 6 colour groups, 3 tourist spots, 6 golden keys and 5 corners or specials', () => {
  assert.strictEqual(L.BOARD.length, 32);
  const kinds = {}; for (const b of L.BOARD) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
  assert.deepStrictEqual(kinds, { start: 1, city: 18, key: 6, tour: 3, island: 1, tax: 1, fund: 1, space: 1 });
  for (const g of Object.keys(L.GROUPS)) assert.strictEqual(L.groupOf(g).length, 3, g);
  assert.strictEqual(L.BOARD[0].kind, 'start'); assert.strictEqual(L.BOARD[L.ISLAND].kind, 'island'); assert.strictEqual(L.BOARD[L.SPACE].kind, 'space');
  const cheap = L.BOARD.filter((b) => b.group === 'A').map((b) => b.price), dear = L.BOARD.filter((b) => b.group === 'F').map((b) => b.price);
  assert.ok(Math.max(...cheap) < Math.min(...dear), 'prices rise around the board');
});

test('a new game: 4 players with 200 each at the start, nobody owns anything, the first player is random', () => {
  const st = fresh();
  assert.strictEqual(st.players.length, 4); assert.ok(st.players.every((p) => p.cash === 200 && p.pos === 0 && !p.bankrupt));
  assert.ok(Object.values(st.props).every((p) => p.owner === -1 && p.level === 0));
  const firsts = new Set(); for (let s = 1; s <= 30; s++) firsts.add(L.newGame(L.rng(s)).turn);
  assert.ok(firsts.size >= 3);
});

test('rolling moves the token by the dice total and the turn ends if nothing is to be decided', () => {
  const st = fresh(); st.players[0].pos = 1;
  rollWith(st, 1, 2);                      // 3칸 -> 황금열쇠가 아닌 곳: index 4 마닐라는 살 수 있음
  assert.strictEqual(st.players[0].pos, 4);
  assert.strictEqual(st.phase, 'decide'); assert.strictEqual(st.pending.type, 'buy');
});

test('passing or landing on the start gives the salary', () => {
  const st = fresh(); st.players[0].pos = 30;
  rollWith(st, 1, 3);                      // 30 + 4 = 34 -> 2 (출발을 지남)
  assert.strictEqual(st.players[0].pos, 2); assert.strictEqual(st.players[0].cash, 200 + 15);
  const s2 = fresh(); s2.players[0].pos = 28;
  rollWith(s2, 1, 3);                      // 정확히 출발
  assert.strictEqual(s2.players[0].pos, 0); assert.strictEqual(s2.players[0].cash, 215);
});

test('buying an unowned city costs its price and the owner is recorded; skipping buys nothing', () => {
  const st = fresh(); st.players[0].pos = 0;
  rollWith(st, 1, 2);                      // 3: 홍콩
  assert.strictEqual(L.BOARD[st.players[0].pos].name, '홍콩');
  assert.ok(L.buy(st)); assert.strictEqual(st.props[3].owner, 0); assert.strictEqual(st.players[0].cash, 200 - 6);
  assert.strictEqual(st.turn, 1, 'next player');
  const s2 = fresh(); rollWith(s2, 1, 2); assert.ok(L.skip(s2)); assert.strictEqual(s2.props[3].owner, -1); assert.strictEqual(s2.players[0].cash, 200);
});

test('landing on your own city offers the next building level, up to a hotel; buildings cost more each step', () => {
  const st = fresh(); const i = give(st, 0, '타이베이'); st.players[0].pos = 29;
  rollWith(st, 1, 3);                      // 29 + 4 = 33 -> 1 타이베이
  assert.strictEqual(st.players[0].pos, i);
  assert.strictEqual(st.phase, 'decide'); assert.strictEqual(st.pending.type, 'build'); assert.strictEqual(st.pending.cost, L.buildCost(i, 0));
  assert.deepStrictEqual([0, 1, 2, 3].map((l) => L.buildCost(i, l)), [3, 3, 5, 8]);
  L.build(st); assert.strictEqual(st.props[i].level, 1);
  const s2 = fresh(); const j = give(s2, 0, '서울', 4); s2.players[0].pos = 27; rollWith(s2, 1, 2);
  assert.strictEqual(s2.players[0].pos, j); assert.strictEqual(s2.phase === 'decide', false, 'a hotel cannot be built further');
});

test('toll: grows with each building level; owning the whole colour group doubles the plain-land toll', () => {
  const st = fresh(); const i = give(st, 1, '서울');
  const tolls = []; for (let l = 0; l <= 4; l++) { st.props[i].level = l; tolls.push(L.tollOf(st, i)); }
  for (let l = 1; l <= 4; l++) assert.ok(tolls[l] > tolls[l - 1]);
  assert.strictEqual(tolls[0], Math.round(32 * L.TOLL_MULT[0]));
  const base = L.tollOf(st, i); st.props[i].level = 0;
  give(st, 1, '하와이'); give(st, 1, '도쿄');
  assert.strictEqual(L.tollOf(st, i), Math.round(32 * L.TOLL_MULT[0] * 2));
  st.props[i].level = 1; assert.strictEqual(L.tollOf(st, i), Math.round(32 * L.TOLL_MULT[1]), 'buildings are not doubled again');
  assert.ok(base >= 1);
});

test('landing on someone elses city pays the toll to the owner', () => {
  const st = fresh(); give(st, 1, '홍콩', 2); st.players[0].pos = 0;
  const toll = L.tollOf(st, 3);
  rollWith(st, 1, 2);
  assert.strictEqual(st.players[0].cash, 200 - toll); assert.strictEqual(st.players[1].cash, 200 + toll);
  assert.ok(evs(st, 'toll').length === 1);
});

test('tourist spots: price 20 to 30, no buildings, toll grows with how many you own', () => {
  const st = fresh(); const j = give(st, 1, '제주도'); const one = L.tollOf(st, j);
  give(st, 1, '콩코드'); const two = L.tollOf(st, j);
  assert.ok(two === one * 2);
  st.players[0].pos = 0; rollWith(st, 2, 3);
  assert.strictEqual(L.BOARD[st.players[0].pos].name, '제주도'); assert.strictEqual(st.turn, 1, 'the toll ends the turn');
  assert.strictEqual(st.players[0].cash, 200 - two);
});

test('doubles give another roll; the third double in a row sends you to the island', () => {
  const st = fresh(); st.players[0].pos = 0;
  rollWith(st, 2, 2); L.skip(st);
  assert.strictEqual(st.turn, 0, 'rolls again after a double'); assert.strictEqual(st.phase, 'roll');
  rollWith(st, 3, 3); if (st.phase === 'decide') L.skip(st);
  assert.strictEqual(st.turn, 0);
  rollWith(st, 4, 4);
  assert.strictEqual(st.players[0].pos, L.ISLAND); assert.ok(st.players[0].jailTurns > 0); assert.strictEqual(st.turn, 1);
});

test('the island: leave with a double, with the escape card, by paying 20, or after three failed rolls', () => {
  const st = fresh(); st.players[0].jailTurns = 1; st.players[0].pos = L.ISLAND;
  rollWith(st, 2, 3); assert.strictEqual(st.players[0].jailTurns, 2); assert.strictEqual(st.players[0].pos, L.ISLAND); assert.strictEqual(st.turn, 1);
  const a = fresh(); a.players[0].jailTurns = 1; a.players[0].pos = L.ISLAND; rollWith(a, 3, 3);
  assert.strictEqual(a.players[0].jailTurns, 0); assert.notStrictEqual(a.players[0].pos, L.ISLAND);
  const b = fresh(); b.players[0].jailTurns = 2; b.players[0].pos = L.ISLAND; b.players[0].escape = 1;
  assert.ok(L.useEscape(b)); assert.strictEqual(b.players[0].jailTurns, 0); assert.strictEqual(b.players[0].escape, 0);
  const c = fresh(); c.players[0].jailTurns = 1; c.players[0].pos = L.ISLAND;
  assert.ok(L.payJail(c)); assert.strictEqual(c.players[0].cash, 200 - L.JAIL_FEE); assert.strictEqual(c.players[0].jailTurns, 0);
  const d = fresh(); d.players[0].jailTurns = 3; d.players[0].pos = L.ISLAND; rollWith(d, 1, 2);
  assert.strictEqual(d.players[0].jailTurns, 0); assert.strictEqual(d.players[0].cash <= 200 - L.JAIL_FEE + 15, true);
  assert.ok(d.fund >= 0);
});

test('the welfare fund: money paid into it can be collected on the collecting square', () => {
  const st = fresh(); st.players[0].pos = 13;
  rollWith(st, 1, 1); L.skip(st);                // 15: 납부 칸
  assert.strictEqual(st.players[0].cash, 200 - L.FUND_FEE); assert.strictEqual(st.fund, 15);
  const s2 = fresh(); s2.fund = 40; s2.players[0].pos = 14; rollWith(s2, 1, 1);
  assert.strictEqual(s2.players[0].cash, 240); assert.strictEqual(s2.fund, 0);
});

test('the space trip: landing there lets you pick any square on your next turn', () => {
  const st = fresh(); st.players[0].pos = 22; rollWith(st, 1, 1);
  assert.strictEqual(st.players[0].pos, L.SPACE); assert.ok(st.players[0].trip);
  const s2 = fresh(); s2.players[0].trip = true; s2.players[0].pos = 24; s2.phase = 'space';
  assert.ok(L.chooseSpace(s2, 27)); assert.strictEqual(s2.players[0].pos, 27); assert.strictEqual(s2.players[0].trip, false);
  assert.strictEqual(s2.phase, 'decide', 'can buy where you land');
  const s3 = fresh(); s3.players[0].trip = true; s3.players[0].pos = 24; s3.phase = 'space';
  L.chooseSpace(s3, 3); assert.strictEqual(s3.players[0].cash, 215, 'going past the start pays the salary');
  assert.strictEqual(L.chooseSpace(fresh(), 3), false, 'only when it is the trip phase');
});

test('golden keys: each card has its effect and the deck is shuffled without repeats until empty', () => {
  const st = fresh(7); assert.strictEqual(new Set(st.deck).size, L.KEYS.length); assert.deepStrictEqual([...st.deck].sort(), L.KEYS.map((k) => k.id).sort());
  const b = fresh(); b.deck = ['lottery'];
  b.players[0].pos = 2; L.land(b); assert.strictEqual(b.players[0].cash, 230);
  const c = fresh(); c.deck = ['fine']; c.players[0].pos = 2; L.land(c); assert.strictEqual(c.players[0].cash, 185); assert.strictEqual(c.fund, 15);
  const d = fresh(); d.deck = ['birthday']; d.players[0].pos = 2; L.land(d); assert.strictEqual(d.players[0].cash, 215); assert.ok(d.players.slice(1).every((p) => p.cash === 195));
  const e = fresh(); e.deck = ['toisland']; e.players[0].pos = 2; L.land(e); assert.strictEqual(e.players[0].pos, L.ISLAND); assert.ok(e.players[0].jailTurns > 0);
  const f = fresh(); f.deck = ['escape']; f.players[0].pos = 2; L.land(f); assert.strictEqual(f.players[0].escape, 1);
  const g = fresh(); g.deck = ['tostart']; g.players[0].pos = 2; L.land(g); assert.strictEqual(g.players[0].pos, 0); assert.strictEqual(g.players[0].cash, 215);
  const h = fresh(); h.deck = ['back3']; h.players[0].pos = 18; L.land(h); assert.strictEqual(h.players[0].pos, 15, 'moved back 3 and landed on the fund payment');
  const k = fresh(); k.deck = ['trip']; k.players[0].pos = 2; L.land(k); assert.ok(k.players[0].trip);
  const m = fresh(); give(m, 0, '홍콩', 3); give(m, 0, '마닐라', 1); m.deck = ['repair']; m.players[0].pos = 2; L.land(m); assert.strictEqual(m.players[0].cash, 200 - 12);
});

test('paying more than you have sells buildings and then cities at half price before going bankrupt', () => {
  const st = fresh(); const i = give(st, 0, '서울', 3); const before = L.netWorth(st, 0);
  st.players[0].cash = 5;
  assert.ok(L.pay(st, 0, 20, 1, '시험'));
  assert.ok(st.props[i].level < 3 || st.props[i].owner === -1, 'sold something');
  assert.ok(st.players[0].cash >= 0); assert.strictEqual(st.players[1].cash, 220);
  assert.ok(L.netWorth(st, 0) < before);
});

test('bankruptcy: everything goes back to the bank, the creditor gets the rest, and the last player standing wins', () => {
  const st = fresh(); give(st, 0, '타이베이'); st.players[0].cash = 0;
  const ok = L.pay(st, 0, 500, 1, '시험');
  assert.strictEqual(ok, false); assert.ok(st.players[0].bankrupt);
  assert.strictEqual(st.props[tile('타이베이')].owner, -1);
  assert.ok(st.players[1].cash >= 200); assert.strictEqual(st.phase === 'over', false);
  L.pay(st, 2, 9999, 1, '시험'); L.pay(st, 3, 9999, 1, '시험');
  assert.strictEqual(st.phase, 'over'); assert.strictEqual(st.winner, 1);
});

test('a bankrupt player is skipped, and after the round limit the richest player wins', () => {
  const st = fresh(); st.players[1].bankrupt = true; st.turn = 0; st.phase = 'roll'; rollWith(st, 1, 2); L.skip(st);
  assert.strictEqual(st.turn, 2, 'player 1 is skipped');
  const s2 = fresh(3, { maxRounds: 2 }); s2.players[2].cash = 999;
  for (let k = 0; k < 400 && s2.phase !== 'over'; k++) L.cpuStep(s2) || (s2.players[s2.turn].human = false);
  assert.strictEqual(s2.phase, 'over'); assert.ok(s2.winner >= 0);
});

test('difficulty: easy computers hoard cash and skip buying and building more often', () => {
  const total = (level) => { let owned = 0, builds = 0; for (let g = 1; g <= 25; g++) { const st = L.newGame(L.rng(g * 11), { level, maxRounds: 12 }); st.players.forEach((p) => { p.human = false; }); for (let k = 0; k < 5000 && st.phase !== 'over'; k++) { L.cpuStep(st); for (const e of st.events) if (e.t === 'buy') owned++; else if (e.t === 'build') builds++; st.events = []; } } return owned + builds; };
  assert.ok(total('easy') < total('normal') * 0.9, 'easy ' + total('easy') + ' normal ' + total('normal'));
  const st = L.newGame(L.rng(1), { level: 'easy' }); assert.ok(st.players.slice(1).every((p) => p.easy) && !st.players[0].easy);
});

test('computer players: whole games always finish, never get stuck, and cash is never negative', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const st = L.newGame(L.rng(seed * 7), { level: seed % 2 ? 'normal' : 'easy' }); st.players.forEach((p) => { p.human = false; });
    let k = 0;
    while (st.phase !== 'over' && k < 20000) {
      assert.ok(L.cpuStep(st), 'cpu step ' + st.phase); k++;
      for (const p of st.players) assert.ok(p.cash >= 0 && Number.isFinite(p.cash));
      for (const i of Object.keys(st.props)) { const pr = st.props[i]; assert.ok(pr.level >= 0 && pr.level <= 4); assert.ok(pr.owner === -1 || !st.players[pr.owner].bankrupt, 'no property owned by a bankrupt player'); }
    }
    assert.strictEqual(st.phase, 'over'); assert.ok(st.winner >= 0 && !st.players[st.winner].bankrupt);
  }
});
