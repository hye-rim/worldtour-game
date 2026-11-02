'use strict';
// 세계 일주 보드게임 규칙 (DOM 없음). 화면은 game.js, 시험은 test/logic.test.js
// 돈의 단위는 만 원.
const LOGIC_WORLDTOUR = (() => {
  const START_CASH = 200, SALARY = 15, JAIL_FEE = 20, FUND_FEE = 15, ISLAND = 8, FUND_TAKE = 16, FUND_PAY = 15, SPACE = 24, MAX_ROUNDS = 30, RESERVE = 30;
  const NAMES = ['나', '민수', '지아', '도윤'];
  const GROUPS = { A: '#8a5a3a', B: '#5ac8e8', C: '#e85aa8', D: '#f0902a', E: '#e8442a', F: '#f0d82a' };
  // 칸: kind = start | city | tour | key | island | fund | tax | space
  const T = (kind, name, extra = {}) => ({ kind, name, ...extra });
  const city = (name, group, price) => T('city', name, { group, price });
  const tour = (name, price) => T('tour', name, { price });
  const BOARD = [
    T('start', '출발'),
    city('타이베이', 'A', 5), T('key', '황금열쇠'), city('홍콩', 'A', 6), city('마닐라', 'A', 7), tour('제주도', 20), city('싱가포르', 'B', 8), city('카이로', 'B', 8),
    T('island', '무인도'),
    city('이스탄불', 'B', 9), T('key', '황금열쇠'), city('아테네', 'C', 11), city('코펜하겐', 'C', 12), tour('콩코드', 30), city('스톡홀름', 'C', 12), T('tax', '사회복지기금 납부'),
    T('fund', '사회복지기금 수령'),
    city('베른', 'D', 14), T('key', '황금열쇠'), city('베를린', 'D', 15), city('오타와', 'D', 16), tour('크루즈', 25), city('부에노스아이레스', 'E', 18), city('상파울루', 'E', 19),
    T('space', '우주여행'),
    city('시드니', 'E', 20), T('key', '황금열쇠'), city('하와이', 'F', 24), city('도쿄', 'F', 28), T('key', '황금열쇠'), city('서울', 'F', 32), T('key', '황금열쇠'),
  ];
  const TOLL_MULT = [0.5, 2, 4.5, 9, 16];            // 땅 · 별장1 · 별장2 · 빌딩 · 호텔 (가격에 곱함)
  const BUILD_MULT = [0.5, 0.5, 1.0, 1.5];                // 땅→별장1 · →별장2 · →빌딩 · →호텔 짓는 값(가격에 곱함)
  const LEVEL_NAMES = ['땅', '별장 1', '별장 2', '빌딩', '호텔'];
  const KEYS = [
    { id: 'bonus', text: '보너스! 20만 원을 받아요' }, { id: 'lottery', text: '복권 당첨! 30만 원을 받아요' },
    { id: 'fine', text: '벌금 15만 원을 사회복지기금에 내요' }, { id: 'birthday', text: '생일 파티! 모두에게 5만 원씩 받아요' },
    { id: 'tostart', text: '출발지로 이동 (월급)' }, { id: 'toisland', text: '무인도로 이동' },
    { id: 'escape', text: '무인도 탈출권을 얻었어요' }, { id: 'fwd3', text: '앞으로 3칸' }, { id: 'back3', text: '뒤로 3칸' },
    { id: 'trip', text: '우주여행! 다음 차례에 가고 싶은 칸으로 가요' }, { id: 'repair', text: '건물 수리비: 건물 한 층당 3만 원' },
  ];

  const rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const emit = (st, e) => { st.events.push(e); };
  const isProp = (i) => BOARD[i].kind === 'city' || BOARD[i].kind === 'tour';
  const priceOf = (i) => BOARD[i].price;
  const groupOf = (g) => BOARD.map((b, i) => i).filter((i) => BOARD[i].group === g);

  function newGame(rand = Math.random, opts = {}) {
    const easy = opts.level === 'easy';
    const st = {
      rand, events: [], round: 1, turn: 0, phase: 'roll', pending: null, fund: 0, last: null, winner: -1, difficulty: opts.level || 'normal', maxRounds: opts.maxRounds || MAX_ROUNDS,
      players: (opts.names || NAMES).map((name, i) => ({ name, human: i === 0, cash: opts.cash || START_CASH, pos: 0, jailTurns: 0, escape: 0, trip: false, doubles: 0, bankrupt: false, easy: easy && i > 0 })),
      props: {}, deck: [],
    };
    BOARD.forEach((b, i) => { if (isProp(i)) st.props[i] = { owner: -1, level: 0 }; });
    reshuffle(st);
    st.turn = opts.first !== undefined ? opts.first : Math.floor(rand() * st.players.length);        // 시작하는 사람은 무작위
    startTurn(st);
    return st;
  }
  function reshuffle(st) {
    st.deck = KEYS.map((k) => k.id);
    for (let i = st.deck.length - 1; i > 0; i--) { const j = Math.floor(st.rand() * (i + 1)); [st.deck[i], st.deck[j]] = [st.deck[j], st.deck[i]]; }
  }
  const me = (st) => st.players[st.turn];
  const alive = (st) => st.players.map((p, i) => i).filter((i) => !st.players[i].bankrupt);
  const ownedBy = (st, who) => Object.keys(st.props).map(Number).filter((i) => st.props[i].owner === who);

  // ---------- 통행료와 값 ----------
  function tollOf(st, i) {
    const pr = st.props[i], b = BOARD[i];
    if (b.kind === 'tour') { const n = ownedBy(st, pr.owner).filter((k) => BOARD[k].kind === 'tour').length; return Math.round(b.price * 0.4 * n); }
    let t = b.price * TOLL_MULT[pr.level];
    if (pr.level === 0 && groupOf(b.group).every((k) => st.props[k].owner === pr.owner)) t *= 2;        // 같은 색을 모두 가지면 땅 통행료 두 배
    return Math.max(1, Math.round(t));
  }
  const buildCost = (i, level) => Math.round(BOARD[i].price * BUILD_MULT[level]);
  const assetValue = (st, who) => ownedBy(st, who).reduce((s, i) => { let v = BOARD[i].price; for (let l = 0; l < st.props[i].level; l++) v += buildCost(i, l); return s + v; }, 0);
  const netWorth = (st, who) => st.players[who].cash + assetValue(st, who);

  // ---------- 돈 주고받기 (모자라면 건물과 땅을 팔고, 그래도 모자라면 파산) ----------
  function sellOne(st, who) {
    const mine = ownedBy(st, who);
    if (!mine.length) return false;
    // 가장 높은 건물부터, 건물이 없으면 가장 싼 땅부터
    const built = mine.filter((i) => st.props[i].level > 0).sort((a, b) => st.props[b].level - st.props[a].level || BOARD[b].price - BOARD[a].price);
    if (built.length) { const i = built[0], pr = st.props[i]; pr.level--; const refund = Math.round(buildCost(i, pr.level) / 2); st.players[who].cash += refund; emit(st, { t: 'sell', who, tile: i, what: 'building', amount: refund }); return true; }
    const land = mine.sort((a, b) => BOARD[a].price - BOARD[b].price)[0];
    st.props[land].owner = -1; const refund = Math.round(BOARD[land].price / 2); st.players[who].cash += refund; emit(st, { t: 'sell', who, tile: land, what: 'land', amount: refund });
    return true;
  }
  // who 가 to(-1 은 은행/기금) 에게 amount 를 낸다. 파산하면 false
  function pay(st, who, amount, to = -1, why = '') {
    const p = st.players[who];
    while (p.cash < amount && sellOne(st, who)) { /* 팔아서 마련 */ }
    if (p.cash < amount) { bankrupt(st, who, to); return false; }
    p.cash -= amount;
    if (to >= 0) st.players[to].cash += amount;
    if (to === -2) st.fund += amount;
    emit(st, { t: 'pay', who, to, amount, why });
    return true;
  }
  function bankrupt(st, who, to) {
    const p = st.players[who];
    if (to >= 0) st.players[to].cash += p.cash;
    p.cash = 0; p.bankrupt = true;
    for (const i of ownedBy(st, who)) { st.props[i].owner = -1; st.props[i].level = 0; }
    emit(st, { t: 'bankrupt', who, to });
    if (alive(st).length === 1) finish(st, alive(st)[0]);
  }
  function finish(st, winner) { st.phase = 'over'; st.winner = winner; st.pending = null; emit(st, { t: 'over', winner }); }

  // ---------- 턴 ----------
  function startTurn(st) {
    const p = me(st);
    st.pending = null;
    if (p.trip && p.jailTurns === 0) { st.phase = 'space'; emit(st, { t: 'turn', who: st.turn, space: true }); return; }
    st.phase = 'roll'; emit(st, { t: 'turn', who: st.turn });
  }
  function nextTurn(st) {
    if (st.phase === 'over') return;
    me(st).doubles = 0;
    let n = st.turn;
    for (let k = 0; k < st.players.length; k++) { n = (n + 1) % st.players.length; if (n <= st.turn) st.round++; if (!st.players[n].bankrupt) break; }
    st.turn = n;
    if (st.round > st.maxRounds) { const rich = alive(st).sort((a, b) => netWorth(st, b) - netWorth(st, a))[0]; finish(st, rich); return; }
    startTurn(st);
  }
  function afterAction(st) {          // 칸에서 할 일이 끝났을 때: 더블이면 한 번 더, 아니면 다음 사람
    if (st.phase === 'over') return;
    const p = me(st);
    if (p.bankrupt) return nextTurn(st);
    if (st.last && st.last.double && p.jailTurns === 0 && p.doubles > 0 && p.doubles < 3) { st.phase = 'roll'; emit(st, { t: 'again', who: st.turn }); return; }
    nextTurn(st);
  }
  function move(st, steps) {
    const p = me(st), target = ((p.pos + steps) % 32 + 32) % 32;
    const wraps = steps > 0 && p.pos + steps >= 32;
    p.pos = target;
    if (wraps) { p.cash += SALARY; emit(st, { t: 'salary', who: st.turn, amount: SALARY }); }
    emit(st, { t: 'move', who: st.turn, to: target, steps });
  }
  function goIsland(st) {
    const p = me(st);
    p.pos = ISLAND; p.jailTurns = 1; p.doubles = 0; st.last = { ...(st.last || {}), double: false };
    emit(st, { t: 'move', who: st.turn, to: ISLAND, direct: true });
    emit(st, { t: 'island', who: st.turn });
  }

  function roll(st) {
    if (st.phase !== 'roll') return false;
    const p = me(st), a = 1 + Math.floor(st.rand() * 6), b = 1 + Math.floor(st.rand() * 6), dbl = a === b;
    st.last = { a, b, double: dbl };
    emit(st, { t: 'dice', who: st.turn, a, b });
    if (p.jailTurns > 0) {                                           // 무인도: 더블이 나오면 탈출, 세 번째에는 벌금을 내고 나옴
      if (dbl) { p.jailTurns = 0; emit(st, { t: 'free', who: st.turn, how: 'double' }); st.last.double = false; move(st, a + b); land(st); return true; }
      p.jailTurns++;
      if (p.jailTurns > 3) {
        p.jailTurns = 0; emit(st, { t: 'free', who: st.turn, how: 'fee' });
        if (!pay(st, st.turn, JAIL_FEE, -2, '무인도 탈출비')) { afterAction(st); return true; }
        st.last.double = false; move(st, a + b); land(st); return true;
      }
      emit(st, { t: 'stay', who: st.turn, turns: p.jailTurns });
      st.last.double = false; afterAction(st); return true;
    }
    if (dbl) { p.doubles++; if (p.doubles >= 3) { emit(st, { t: 'tripledouble', who: st.turn }); goIsland(st); afterAction(st); return true; } }
    else p.doubles = 0;
    move(st, a + b); land(st);
    return true;
  }
  function payJail(st) {
    const p = me(st);
    if (st.phase !== 'roll' || p.jailTurns === 0) return false;
    if (!pay(st, st.turn, JAIL_FEE, -2, '무인도 탈출비')) { afterAction(st); return true; }
    p.jailTurns = 0; emit(st, { t: 'free', who: st.turn, how: 'fee' });
    return true;
  }
  function useEscape(st) {
    const p = me(st);
    if (st.phase !== 'roll' || p.jailTurns === 0 || p.escape < 1) return false;
    p.escape--; p.jailTurns = 0; emit(st, { t: 'free', who: st.turn, how: 'card' });
    return true;
  }

  function land(st) {
    const p = me(st), i = p.pos, b = BOARD[i];
    emit(st, { t: 'land', who: st.turn, tile: i });
    if (b.kind === 'city' || b.kind === 'tour') {
      const pr = st.props[i];
      if (pr.owner === -1) { if (p.cash >= b.price) { st.pending = { type: 'buy', tile: i, cost: b.price }; st.phase = 'decide'; return; } emit(st, { t: 'broke', who: st.turn, tile: i }); }
      else if (pr.owner === st.turn) {
        if (b.kind === 'city' && pr.level < 4) { const c = buildCost(i, pr.level); if (p.cash >= c) { st.pending = { type: 'build', tile: i, cost: c, level: pr.level + 1 }; st.phase = 'decide'; return; } }
      } else {
        const toll = tollOf(st, i);
        emit(st, { t: 'toll', who: st.turn, to: pr.owner, tile: i, amount: toll });
        if (!pay(st, st.turn, toll, pr.owner, '통행료')) { afterAction(st); return; }
      }
    } else if (b.kind === 'key') { if (!drawKey(st)) return; if (st.phase === 'decide' || st.phase === 'over') return; }
    else if (b.kind === 'tax') { emit(st, { t: 'tax', who: st.turn, amount: FUND_FEE }); if (!pay(st, st.turn, FUND_FEE, -2, '사회복지기금')) { afterAction(st); return; } }
    else if (b.kind === 'fund') { const g = st.fund; st.fund = 0; p.cash += g; emit(st, { t: 'fundtake', who: st.turn, amount: g }); }
    else if (b.kind === 'space') { p.trip = true; emit(st, { t: 'trip', who: st.turn }); }
    else if (b.kind === 'start') { p.cash += 0; }
    else if (b.kind === 'island') { /* 지나가는 중이면 아무 일 없음 */ }
    afterAction(st);
  }
  function drawKey(st) {
    if (!st.deck.length) reshuffle(st);
    const id = st.deck.pop(), p = me(st);
    emit(st, { t: 'key', who: st.turn, id, text: KEYS.find((k) => k.id === id).text });
    if (id === 'bonus') p.cash += 20;
    else if (id === 'lottery') p.cash += 30;
    else if (id === 'fine') { if (!pay(st, st.turn, 15, -2, '벌금')) { afterAction(st); return false; } }
    else if (id === 'birthday') { for (const i of alive(st)) if (i !== st.turn) { if (st.players[i].cash >= 5 || ownedBy(st, i).length) { if (!pay(st, i, 5, st.turn, '생일')) { if (st.phase === 'over') return false; } } } }
    else if (id === 'tostart') { p.pos = 0; p.cash += SALARY; emit(st, { t: 'salary', who: st.turn, amount: SALARY }); emit(st, { t: 'move', who: st.turn, to: 0, direct: true }); }
    else if (id === 'toisland') { goIsland(st); }
    else if (id === 'escape') p.escape++;
    else if (id === 'fwd3') { move(st, 3); land(st); return false; }
    else if (id === 'back3') { move(st, -3); land(st); return false; }
    else if (id === 'trip') p.trip = true;
    else if (id === 'repair') { const floors = ownedBy(st, st.turn).reduce((s, i) => s + st.props[i].level, 0); if (floors && !pay(st, st.turn, floors * 3, -2, '수리비')) { afterAction(st); return false; } }
    return true;
  }

  // ---------- 선택 ----------
  function buy(st) {
    if (st.phase !== 'decide' || !st.pending || st.pending.type !== 'buy') return false;
    const { tile, cost } = st.pending, p = me(st);
    if (p.cash < cost) return false;
    p.cash -= cost; st.props[tile].owner = st.turn; st.pending = null;
    emit(st, { t: 'buy', who: st.turn, tile, amount: cost });
    afterAction(st); return true;
  }
  function build(st) {
    if (st.phase !== 'decide' || !st.pending || st.pending.type !== 'build') return false;
    const { tile, cost } = st.pending, p = me(st);
    if (p.cash < cost) return false;
    p.cash -= cost; st.props[tile].level++; st.pending = null;
    emit(st, { t: 'build', who: st.turn, tile, level: st.props[tile].level, amount: cost });
    afterAction(st); return true;
  }
  function skip(st) {
    if (st.phase !== 'decide') return false;
    st.pending = null; emit(st, { t: 'skip', who: st.turn });
    afterAction(st); return true;
  }
  function chooseSpace(st, idx) {
    if (st.phase !== 'space' || idx < 0 || idx > 31) return false;
    const p = me(st);
    p.trip = false;
    const wraps = idx <= p.pos;
    p.pos = idx;
    if (wraps) { p.cash += SALARY; emit(st, { t: 'salary', who: st.turn, amount: SALARY }); }
    emit(st, { t: 'move', who: st.turn, to: idx, direct: true, space: true });
    st.last = { double: false };
    land(st);
    return true;
  }

  // ---------- 컴퓨터 ----------
  function completesGroup(st, who, i) { const b = BOARD[i]; return b.kind === 'city' && groupOf(b.group).every((k) => k === i || st.props[k].owner === who); }
  function cpuStep(st) {
    if (st.phase === 'over' || me(st).human) return false;
    const p = me(st), r = st.rand;
    const reserve = p.easy ? 80 : RESERVE;
    if (st.phase === 'roll') {
      if (p.jailTurns > 0) {
        if (p.escape > 0) return useEscape(st);
        if (p.cash > 150 && st.round < 20 && !p.easy) return payJail(st);              // 초반엔 돈을 내고서라도 나와 땅을 산다
      }
      return roll(st);
    }
    if (st.phase === 'decide') {
      const pd = st.pending;
      if (pd.type === 'buy') {
        const good = completesGroup(st, st.turn, pd.tile) || BOARD[pd.tile].kind === 'tour';
        const ok = p.cash - pd.cost >= (good ? 10 : reserve);
        if (p.easy && r() < 0.45) return skip(st);
        return ok ? buy(st) : skip(st);
      }
      const ok = p.cash - pd.cost >= reserve + 10 && !(p.easy && r() < 0.6);
      return ok ? build(st) : skip(st);
    }
    if (st.phase === 'space') {
      let best = 0, bestV = -1e9;
      for (let i = 0; i < 32; i++) {
        let v = 0; const b = BOARD[i];
        if (isProp(i)) { const pr = st.props[i]; if (pr.owner === -1) v = 10 + (completesGroup(st, st.turn, i) ? 30 : 0) + b.price * 0.3; else if (pr.owner === st.turn) v = b.kind === 'city' && pr.level < 4 ? 6 + pr.level : -2; else v = -tollOf(st, i) * 2; }
        else if (b.kind === 'fund') v = 5 + st.fund * 0.7;
        else if (b.kind === 'island' || b.kind === 'tax') v = -8;
        else if (b.kind === 'start') v = 6;
        v += r() * 3;
        if (v > bestV) { bestV = v; best = i; }
      }
      return chooseSpace(st, best);
    }
    return false;
  }

  return {
    START_CASH, SALARY, JAIL_FEE, FUND_FEE, MAX_ROUNDS, BOARD, GROUPS, TOLL_MULT, BUILD_MULT, LEVEL_NAMES, KEYS, NAMES, ISLAND, SPACE,
    rng, newGame, roll, buy, build, skip, payJail, useEscape, chooseSpace, cpuStep, tollOf, buildCost, assetValue, netWorth, ownedBy, groupOf, isProp, alive, pay, goIsland, land,
  };
})();
if (typeof module !== 'undefined') module.exports = LOGIC_WORLDTOUR;
