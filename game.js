'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 세계 일주 보드게임: 화면·입력·소리. 규칙과 컴퓨터는 logic.js (LOGIC_WORLDTOUR). 여기서는 st.events 를 보고 소리·표시를 만든다.
const L = LOGIC_WORLDTOUR;
const W = 240, H = 300;
const CORNER = 30, CELL = (240 - 2 * CORNER) / 7;
const COLORS = ['#4aa8ff', '#ff6a6a', '#5ad87a', '#ffd23a'];

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

function fit() {
  const ctrlH = $('controls').offsetHeight + 10;
  const scale = Math.min((innerWidth - 16) / W, (innerHeight - 16 - ctrlH) / H);
  const cssW = Math.max(150, Math.floor(W * scale)), cssH = Math.floor(cssW * H / W);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
}
addEventListener('resize', fit);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

// ---------- 소리 ----------
let audio = null;
let muted = store.get('worldtourMuted') === '1';
function tone(freq, dur, type = 'square', vol = 0.045, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  } catch (_) {}
}
function noise(dur, vol = 0.08, lowpass = 3000) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(audio.sampleRate * dur), buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = audio.createBufferSource(), g = audio.createGain(), f = audio.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lowpass; g.gain.value = vol;
    s.buffer = buf; s.connect(f).connect(g).connect(audio.destination); s.start();
  } catch (_) {}
}
const melody = (notes, step, type = 'sine', vol = 0.06) => notes.forEach((f, i) => { if (f) setTimeout(() => tone(f, step * 0.9 / 1000, type, vol), i * step); });
const sfx = {
  dice: () => { for (let k = 0; k < 4; k++) setTimeout(() => noise(0.04, 0.07, 3000), k * 55); },
  step: () => tone(520, 0.03, 'triangle', 0.025),
  buy: () => melody([523, 659, 784], 70, 'triangle', 0.05),
  build: () => melody([392, 523, 659, 784], 60, 'square', 0.04),
  pay: () => melody([440, 330], 90, 'sawtooth', 0.04),
  get: () => melody([784, 988], 70, 'sine', 0.05),
  key: () => melody([880, 1175, 988], 70, 'sine', 0.05),
  bad: () => tone(160, 0.14, 'square', 0.04),
  island: () => melody([330, 262, 196], 110, 'sawtooth', 0.04),
  bankrupt: () => melody([330, 262, 196, 147], 140, 'sawtooth', 0.05),
  win: () => melody([523, 659, 784, 1047], 90),
  lose: () => melody([330, 262, 196], 160, 'sawtooth', 0.04),
  start: () => melody([392, 494, 587], 90),
};

// ---------- 상태 ----------
let G = L.newGame();
let state = 'title';                           // title · play · paused
let best = Number(store.get('worldtourBest')) || 0;
let pausedFrom = null, cpuT = 0, busy = 0, diceShow = null, diceT = 0;
let logLines = [], banner = { text: '', sub: '', t: 0 }, shownPos = G.players.map(() => 0), moveQueue = [];
let tutorialRig = false;

/* @test-hooks:start */
window.__wt = { get G() { return G; }, get state() { return state; }, L, setG(g) { G = g; }, step: (dt) => update(dt) };
/* @test-hooks:end */

// ---------- 흐름 ----------
function bindOverlay() { document.querySelectorAll('#overlay button').forEach((b) => { b.onclick = () => onOverlayButton(b.dataset.level); }); }
function showOverlay(html) { const o = $('overlay'); o.innerHTML = html; o.classList.remove('hidden'); bindOverlay(); }
function hideOverlay() { $('overlay').classList.add('hidden'); }
const LEVEL_BUTTONS = '<div class="lv"><button id="startBtn" data-level="easy">쉬움<small>컴퓨터가 소극적이에요</small></button><button id="startBtn2" data-level="normal">보통<small>컴퓨터가 적극적이에요</small></button></div><p class="note">쉬움에서는 최고 기록이 저장되지 않아요</p>';
function onOverlayButton(level) { if (state === 'paused') resume(); else startGame(level); }
function startGame(level) {
  const tut = /[?&]tutorial=1/.test(location.search);
  if (tut) level = 'easy';
  level = level || store.get('worldtourLevel');
  level = level === 'normal' ? 'normal' : 'easy';
  store.set('worldtourLevel', level);
  G = L.newGame(Math.random, { level, first: tut ? 0 : undefined });
  tutorialRig = tut;
  shownPos = G.players.map(() => 0); moveQueue = []; logLines = []; diceShow = null; cpuT = 0; busy = 0;
  state = 'play'; hideOverlay(); sfx.start();
  setBanner('출발!', `${G.players[G.turn].name} 먼저 · ${level === 'easy' ? '쉬움' : '보통'} · ${G.maxRounds}바퀴`, 2);
  handleEvents(); refresh();
}
function pause() {
  if (state !== 'play') return;
  pausedFrom = state; state = 'paused';
  showOverlay('<h2>일시정지</h2><p>P 키나 아래 버튼으로 계속해요</p><button id="startBtn">계속하기</button>');
}
function resume() { if (state !== 'paused') return; state = pausedFrom; hideOverlay(); }
function setBanner(text, sub = '', t = 2) { banner = { text, sub, t }; }
const nm = (i) => G.players[i].name;
const tn = (i) => L.BOARD[i].name;
const log = (t, color) => { logLines.push({ t, color }); if (logLines.length > 5) logLines.shift(); };

function handleEvents() {
  const evs = G.events; G.events = [];
  for (const e of evs) {
    const c = e.who !== undefined ? COLORS[e.who] : '#fff';
    if (e.t === 'turn') { if (e.who === 0 && state === 'play') sfx.step(); }
    else if (e.t === 'dice') { diceShow = [e.a, e.b]; diceT = 0; sfx.dice(); log(`${nm(e.who)} 주사위 ${e.a}+${e.b}=${e.a + e.b}${e.a === e.b ? ' (더블!)' : ''}`, c); if (e.who === 0) tutorialSignal('roll'); }
    else if (e.t === 'move') { moveQueue.push({ who: e.who, to: e.to, steps: e.steps, direct: !!e.direct }); }
    else if (e.t === 'salary') { log(`${nm(e.who)} 월급 +${e.amount}만`, c); if (e.who === 0) sfx.get(); }
    else if (e.t === 'buy') { log(`${nm(e.who)} ${tn(e.tile)} 구매 -${e.amount}만`, c); sfx.buy(); if (e.who === 0) tutorialSignal('buy'); }
    else if (e.t === 'build') { log(`${nm(e.who)} ${tn(e.tile)} ${L.LEVEL_NAMES[e.level]} 건설 -${e.amount}만`, c); sfx.build(); if (e.who === 0) tutorialSignal('build'); }
    else if (e.t === 'toll') { log(`${nm(e.who)} → ${nm(e.to)} 통행료 ${e.amount}만 (${tn(e.tile)})`, c); sfx.pay(); if (e.who === 0) { setBanner('통행료!', `${nm(e.to)}에게 ${e.amount}만 원`, 1.6); tutorialSignal('toll'); } else if (e.to === 0) { sfx.get(); setBanner('통행료 수입!', `${nm(e.who)}에게서 ${e.amount}만 원`, 1.6); } }
    else if (e.t === 'tax') { log(`${nm(e.who)} 사회복지기금 납부 -${e.amount}만`, c); sfx.pay(); }
    else if (e.t === 'fundtake') { log(`${nm(e.who)} 사회복지기금 수령 +${e.amount}만`, c); sfx.get(); if (e.amount) setBanner('기금 수령!', `+${e.amount}만 원`, 1.4); }
    else if (e.t === 'key') { log(`${nm(e.who)} 황금열쇠: ${e.text}`, c); sfx.key(); setBanner('황금열쇠', e.text, 2.6); if (e.who === 0) tutorialSignal('key'); }
    else if (e.t === 'island') { log(`${nm(e.who)} 무인도로!`, c); sfx.island(); if (e.who === 0) tutorialSignal('island'); }
    else if (e.t === 'tripledouble') setBanner('더블 세 번!', '무인도로 가요', 2);
    else if (e.t === 'free') log(`${nm(e.who)} 무인도 탈출 (${e.how === 'double' ? '더블' : e.how === 'card' ? '탈출권' : '20만 원'})`, c);
    else if (e.t === 'stay') log(`${nm(e.who)} 무인도에 머무름 (${e.turns}/3)`, c);
    else if (e.t === 'trip') { log(`${nm(e.who)} 우주여행 칸! 다음 차례에 원하는 칸으로`, c); sfx.key(); }
    else if (e.t === 'sell') { log(`${nm(e.who)} ${tn(e.tile)} ${e.what === 'land' ? '땅' : '건물'} 매각 +${e.amount}만`, c); sfx.bad(); }
    else if (e.t === 'bankrupt') { log(`${nm(e.who)} 파산!`, '#ff9a9a'); sfx.bankrupt(); setBanner('파산!', `${nm(e.who)}가 탈락했어요`, 2.4); }
    else if (e.t === 'broke') log(`${nm(e.who)} 돈이 모자라 ${tn(e.tile)}을 못 사요`, c);
    else if (e.t === 'skip') { /* 안 샀음 */ }
    else if (e.t === 'over') showEnd();
  }
}
function showEnd() {
  const won = G.winner === 0, nw = L.netWorth(G, 0);
  (won ? sfx.win : sfx.lose)();
  const rows = G.players.map((p, i) => `<tr><td style="color:${COLORS[i]}">${p.name}</td><td>${p.bankrupt ? '파산' : L.netWorth(G, i) + '만'}</td></tr>`).join('');
  let extra = '';
  if (G.difficulty === 'normal' && won && nw > best) { best = nw; store.set('worldtourBest', String(best)); extra = '<p>🏆 최고 기록!</p>'; }
  setTimeout(() => showOverlay(`<h2>${won ? '🏆 내가 1등!' : `${nm(G.winner)} 승리`}</h2><p class="big">${G.round > G.maxRounds ? `${G.maxRounds}바퀴 끝 · 자산 1등` : '마지막까지 살아남았어요'}</p><table style="font-size:13px;border-spacing:10px 2px">${rows}</table>${extra}${LEVEL_BUTTONS}`), 1200);
}

// ---------- 매 프레임 ----------
function update(dt) {
  if (state !== 'play') return;
  banner.t = Math.max(0, banner.t - dt);
  diceT += dt;
  // 말 옮기기 애니메이션: 한 칸씩 (순간이동은 바로)
  if (moveQueue.length) {
    busy = 0.2;
    const m = moveQueue[0], cur = shownPos[m.who];
    if (m.direct || cur === m.to) { shownPos[m.who] = m.to; moveQueue.shift(); }
    else { stepTimer -= dt; if (stepTimer <= 0) { stepTimer = 0.07; shownPos[m.who] = m.steps < 0 ? (cur + 31) % 32 : (cur + 1) % 32; sfx.step(); } }
    refresh(); return;
  }
  busy = Math.max(0, busy - dt);
  if (G.phase === 'over') return;
  const p = G.players[G.turn];
  if (!p.human) {
    cpuT += dt;
    if (cpuT >= 0.9 && busy <= 0) { cpuT = 0; L.cpuStep(G); handleEvents(); refresh(); }
  } else cpuT = 0;
}
let stepTimer = 0;

// ---------- 버튼 ----------
const myTurn = () => state === 'play' && G.phase !== 'over' && G.players[G.turn].human && !moveQueue.length;
function setBtn(id, text, on, small = '') { const b = $(id); b.classList.toggle('hidden', !text); b.innerHTML = text ? text + (small ? `<small>${small}</small>` : '') : ''; b.disabled = !on; }
function refresh() {
  const mine = myTurn(), p = G.players[0];
  let hint = '';
  setBtn('btnMain', '', false); setBtn('btnSecond', '', false); setBtn('btnThird', '', false);
  if (G.phase === 'over') { $('hint').textContent = ''; return; }
  if (!mine) {
    setBtn('btnMain', '기다리는 중…', false);
    hint = G.players[G.turn].human ? '' : `${G.players[G.turn].name} 차례`;
  } else if (G.phase === 'roll') {
    if (p.jailTurns > 0) {
      setBtn('btnMain', '주사위 굴리기', true, '더블이면 탈출');
      setBtn('btnSecond', `${L.JAIL_FEE}만 내고 탈출`, p.cash >= L.JAIL_FEE);
      if (p.escape > 0) setBtn('btnThird', '탈출권 사용', true, `${p.escape}장`);
      hint = `무인도 ${p.jailTurns}/3 — 더블이 나오거나 세 번째엔 벌금을 내고 나와요`;
    } else { setBtn('btnMain', '주사위 굴리기', true); hint = '내 차례'; }
  } else if (G.phase === 'decide') {
    const pd = G.pending;
    if (pd.type === 'buy') { setBtn('btnMain', `구매 ${pd.cost}만`, true, tn(pd.tile)); setBtn('btnSecond', '안 사요', true); hint = `${tn(pd.tile)}을(를) 살까요? (가진 돈 ${p.cash}만)`; }
    else { setBtn('btnMain', `${L.LEVEL_NAMES[pd.level]} 짓기 ${pd.cost}만`, true, tn(pd.tile)); setBtn('btnSecond', '안 지어요', true); hint = `${tn(pd.tile)}에 건물을 지을까요? (통행료가 올라가요)`; }
  } else if (G.phase === 'space') { setBtn('btnMain', '가고 싶은 칸을 눌러요', false); hint = '우주여행! 판에서 도착할 칸을 눌러요'; }
  $('hint').textContent = hint;
}
function primary() {
  if (!myTurn()) return;
  if (G.phase === 'roll') { rigDice(); L.roll(G); }
  else if (G.phase === 'decide') { G.pending.type === 'buy' ? L.buy(G) : L.build(G); }
  handleEvents(); refresh();
}
function secondary() {
  if (!myTurn()) return;
  if (G.phase === 'roll' && G.players[0].jailTurns > 0) L.payJail(G);
  else if (G.phase === 'decide') L.skip(G);
  handleEvents(); refresh();
}
function third() { if (!myTurn()) return; if (G.phase === 'roll' && G.players[0].escape > 0) L.useEscape(G); handleEvents(); refresh(); }
// 튜토리얼: 첫 주사위는 살 수 있는 도시(홍콩)에 멈추도록 3(1+2)을 던진다
function rigDice() {
  if (!tutorialRig) return;
  tutorialRig = false;
  const orig = G.rand, q = [(1 - 0.5) / 6, (2 - 0.5) / 6];
  G.rand = () => (q.length ? q.shift() : orig());
  setTimeout(() => { G.rand = orig; }, 0);
}
$('btnMain').onclick = primary; $('btnSecond').onclick = secondary; $('btnThird').onclick = third;
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (state === 'title') { if (k === 'enter' || k === ' ') { e.preventDefault(); onOverlayButton(); } return; }
  if (state === 'paused') { if (k === 'p' || k === 'enter') resume(); return; }
  if (!$('overlay').classList.contains('hidden')) { if (k === 'enter' || k === ' ') { e.preventDefault(); onOverlayButton(); } return; }
  if (k === 'p') pause(); else if (k === 'm') toggleMute();
  else if (k === ' ' || k === 'enter') { e.preventDefault(); primary(); } else if (k === 'n') secondary();
});

// ---------- 그리기 ----------
function tileRect(i) {
  const side = Math.floor(i / 8), k = i % 8;
  // 0~8: 아래줄 오른쪽에서 왼쪽 / 8~16: 왼쪽 줄 아래에서 위 / 16~24: 윗줄 왼쪽에서 오른쪽 / 24~32: 오른쪽 줄 위에서 아래
  if (k === 0) { const corners = [[W - CORNER, H0 - CORNER], [0, H0 - CORNER], [0, 0], [W - CORNER, 0]]; const [x, y] = corners[side]; return { x, y, w: CORNER, h: CORNER, side, corner: true }; }
  const n = k - 1;
  if (side === 0) return { x: W - CORNER - (n + 1) * CELL, y: H0 - CORNER, w: CELL, h: CORNER, side };
  if (side === 1) return { x: 0, y: H0 - CORNER - (n + 1) * CELL, w: CORNER, h: CELL, side };
  if (side === 2) return { x: CORNER + n * CELL, y: 0, w: CELL, h: CORNER, side };
  return { x: W - CORNER, y: CORNER + n * CELL, w: CORNER, h: CELL, side };
}
const H0 = 240;
function text(t, x, y, color = '#fff', size = 7, align = 'center', bold = true) { ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(t, x, y); }
function drawTile(i) {
  const b = L.BOARD[i], r = tileRect(i), pr = G.props[i];
  ctx.fillStyle = '#f4efe0'; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = '#334'; ctx.lineWidth = 0.6; ctx.strokeRect(r.x + 0.3, r.y + 0.3, r.w - 0.6, r.h - 0.6);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (b.kind === 'city') {
    const band = 6;
    ctx.fillStyle = L.GROUPS[b.group];
    if (r.side === 0) ctx.fillRect(r.x, r.y, r.w, band); else if (r.side === 1) ctx.fillRect(r.x + r.w - band, r.y, band, r.h); else if (r.side === 2) ctx.fillRect(r.x, r.y + r.h - band, r.w, band); else ctx.fillRect(r.x, r.y, band, r.h);
  }
  // 이름 (두 줄로 나눔)
  const name = b.name.replace('사회복지기금 ', '복지기금\n'), lines = name.length > 4 && !name.includes('\n') ? [name.slice(0, Math.ceil(name.length / 2)), name.slice(Math.ceil(name.length / 2))] : name.split('\n');
  const ty = cy + (b.kind === 'city' ? (r.side === 0 || r.side === 2 ? (r.side === 0 ? 3 : -3) : 0) : 0);
  const tx = b.kind === 'city' ? cx + (r.side === 1 ? -3 : r.side === 3 ? 3 : 0) : cx;
  const color = b.kind === 'key' ? '#c0392b' : b.kind === 'tour' ? '#1a6a9a' : '#222';
  lines.forEach((ln, k) => text(ln, tx, ty + (k - (lines.length - 1) / 2) * 6.5, color, r.corner ? 7 : 5.6));
  if (b.price) text(`${b.price}`, cx, r.y + r.h - 4, '#555', 5, 'center', false);
  if (b.kind === 'key') text('?', cx, r.y + 6, '#c0392b', 8);
  if (b.kind === 'start') text('▶', cx, r.y + 6, '#2a8a2a', 8);
  // 주인과 건물
  if (pr && pr.owner >= 0) {
    ctx.strokeStyle = COLORS[pr.owner]; ctx.lineWidth = 1.6; ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    for (let l = 0; l < pr.level; l++) { ctx.fillStyle = pr.level === 4 ? '#e8442a' : '#2a8a3a'; ctx.fillRect(r.x + 2 + l * 4.5, r.y + (r.side === 0 ? r.h - 11 : 2) , 3.6, 3.6); }
  }
  if (G.phase === 'space' && myTurn()) { ctx.fillStyle = `rgba(255,225,74,${0.18 + 0.12 * Math.sin(performance.now() / 200)})`; ctx.fillRect(r.x, r.y, r.w, r.h); }
}
function drawTokens() {
  const byTile = {};
  G.players.forEach((p, i) => { if (p.bankrupt) return; (byTile[shownPos[i]] = byTile[shownPos[i]] || []).push(i); });
  for (const [t, who] of Object.entries(byTile)) {
    const r = tileRect(Number(t));
    who.forEach((i, k) => {
      const x = r.x + r.w / 2 + (k % 2 ? 4.5 : -4.5), y = r.y + r.h / 2 + (k > 1 ? 4.5 : -3) + (L.BOARD[t].kind === 'city' ? 1 : 0);
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, 7); ctx.fill();
      ctx.fillStyle = COLORS[i]; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, 7); ctx.fill();
      if (G.turn === i && G.phase !== 'over') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(x, y, 5.2, 0, 7); ctx.stroke(); }
    });
  }
}
function drawDie(x, y, n) {
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, 22, 22); ctx.strokeStyle = '#222'; ctx.strokeRect(x + 0.5, y + 0.5, 21, 21);
  const pos = { 1: [[11, 11]], 2: [[6, 6], [16, 16]], 3: [[6, 6], [11, 11], [16, 16]], 4: [[6, 6], [16, 6], [6, 16], [16, 16]], 5: [[6, 6], [16, 6], [11, 11], [6, 16], [16, 16]], 6: [[6, 5], [16, 5], [6, 11], [16, 11], [6, 17], [16, 17]] };
  ctx.fillStyle = '#c0392b'; for (const [px, py] of pos[n]) { ctx.beginPath(); ctx.arc(x + px, y + py, 2, 0, 7); ctx.fill(); }
}
function draw() {
  ctx.fillStyle = '#103a5a'; ctx.fillRect(0, 0, W, H);
  if (state === 'title') return;
  ctx.fillStyle = '#cfe8d8'; ctx.fillRect(CORNER, CORNER, W - 2 * CORNER, H0 - 2 * CORNER);
  for (let i = 0; i < 32; i++) drawTile(i);
  drawTokens();
  // 가운데: 주사위와 기록
  text('세계 일주', 120, 44, '#2a5a7a', 11);
  if (diceShow) { const rolling = diceT < 0.5, a = rolling ? 1 + Math.floor(Math.random() * 6) : diceShow[0], b = rolling ? 1 + Math.floor(Math.random() * 6) : diceShow[1]; drawDie(94, 54, a); drawDie(124, 54, b); }
  logLines.forEach((ln, k) => text(ln.t.length > 22 ? ln.t.slice(0, 22) + '…' : ln.t, 120, 92 + k * 11, ln.color === '#fff' ? '#223' : '#223', 6.4, 'center', true));
  logLines.forEach((ln, k) => { ctx.fillStyle = ln.color; ctx.fillRect(38, 89 + k * 11, 2.5, 6); });
  text(`${Math.min(G.round, G.maxRounds)} / ${G.maxRounds}바퀴 · 사회복지기금 ${G.fund}만`, 120, 154 + 0, '#2a5a7a', 6.4);
  if (G.phase === 'space' && myTurn()) text('도착할 칸을 눌러요', 120, 170, '#c0392b', 8);
  // 아래: 플레이어 정보
  G.players.forEach((p, i) => {
    const x = 6 + (i % 2) * 118, y = 246 + Math.floor(i / 2) * 26, active = G.turn === i && G.phase !== 'over' && !p.bankrupt;
    ctx.fillStyle = active ? 'rgba(255,225,74,.95)' : 'rgba(0,0,0,.45)'; ctx.fillRect(x, y, 112, 23);
    ctx.fillStyle = COLORS[i]; ctx.beginPath(); ctx.arc(x + 8, y + 11.5, 4.5, 0, 7); ctx.fill();
    text(`${p.name}${p.jailTurns ? ' (무인도)' : ''}${p.escape ? ' 🎫' : ''}`, x + 16, y + 7, active ? '#000' : '#fff', 7, 'left');
    text(p.bankrupt ? '파산' : `현금 ${p.cash}만 · 자산 ${L.netWorth(G, i)}만`, x + 16, y + 17, active ? '#3a2a00' : p.bankrupt ? '#ff9a9a' : '#ffe14a', 6.4, 'left');
  });
  if (banner.t > 0) { ctx.fillStyle = 'rgba(0,0,0,.82)'; ctx.fillRect(45, 108, 150, 44); text(banner.text, 120, 122, '#ffe14a', 12); if (banner.sub) text(banner.sub.length > 24 ? banner.sub.slice(0, 24) + '…' : banner.sub, 120, 140, '#fff', 7, 'center', false); }
}
canvas.addEventListener('pointerdown', (e) => {
  if (!(state === 'play' && G.phase === 'space' && myTurn())) return;
  const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
  for (let i = 0; i < 32; i++) { const t = tileRect(i); if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) { if (L.chooseSpace(G, i)) { handleEvents(); refresh(); } return; } }
});

let last = 0;
function frame(ts) {
  const dt = Math.min(0.1, (ts - (last || ts)) / 1000);
  last = ts;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
function toggleMute() { muted = !muted; store.set('worldtourMuted', muted ? '1' : '0'); $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('pauseBtn').onclick = (e) => { e.currentTarget.blur(); state === 'paused' ? resume() : pause(); };
bindOverlay();
$('muteBtn').textContent = muted ? '🔇' : '🔊';
addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
refresh();
fit();
requestAnimationFrame(frame);
