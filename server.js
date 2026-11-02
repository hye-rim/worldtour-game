'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 규칙과 컴퓨터는 브라우저와 같은 코드를 쓴다. 주사위·황금열쇠는 서버가 굴리고 섞는다
const L = require('./public/logic.js');
const rand = () => crypto.randomInt(1 << 30) / (1 << 30);

// ---------- Config ----------
const PORT = process.env.PORT || 3023;
const TURN_MS = Number(process.env.TURN_MS) || 60000;   // 한 번 고를 때마다 제한 시간. 넘기면 컴퓨터가 대신한다. 시험에서는 환경변수로 줄인다
const CPU_MS = Number(process.env.CPU_MS) || 900;       // 컴퓨터가 한 번 움직이는 간격 (화면 연출 시간)
const GRACE_MS = Number(process.env.GRACE_MS) || 30000; // 대국 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 한다
const MAX_IDLE = 3;                                     // 연달아 시간을 넘기면 그 사람은 컴퓨터가 맡는다
const MAX_SEATS = 4;
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CPU_NAMES = ['민수', '지아', '도윤', '하나'];

// ---------- Static file server ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
function safeDecode(s) {
  try {
    const d = decodeURIComponent(s);
    return d.includes('\0') ? null : d;
  } catch { return null; }
}
function isServable(filePath, baseDir) {
  const inside = filePath === baseDir || filePath.startsWith(baseDir + path.sep);
  return inside && !filePath.slice(baseDir.length).split(path.sep).some((seg) => seg.startsWith('.'));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  let reqPath = safeDecode(req.url.split('?')[0]);
  if (reqPath === null) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!isServable(filePath, PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// 메시지 크기 제한: 이 게임의 메시지는 모두 작다
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------- 방 코드 무차별 대입 방지 ----------
const JOIN_FAIL_MAX = 8, JOIN_WINDOW_MS = 60000, JOIN_BLOCK_MS = 60000;
const joinFails = new Map();
const clientIp = (req) => String((req && req.headers['x-forwarded-for']) || (req && req.socket.remoteAddress) || '').split(',')[0].trim();
const joinBlocked = (ip) => { const f = joinFails.get(ip); return !!f && f.until > Date.now(); };
function noteJoinFail(ip) {
  const now = Date.now();
  let f = joinFails.get(ip);
  if (!f || now - f.since > JOIN_WINDOW_MS) f = { n: 0, since: now, until: 0 };
  f.n++;
  if (f.n >= JOIN_FAIL_MAX) { f.until = now + JOIN_BLOCK_MS; f.n = 0; f.since = now; }
  joinFails.set(ip, f);
  if (joinFails.size > 2000) for (const [k, v] of joinFails) if (v.until < now && now - v.since > JOIN_WINDOW_MS) joinFails.delete(k);
}

// ---------- State ----------
const rooms = new Map();
const clients = new Map();
let queue = null;
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}
function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}
const makeToken = () => crypto.randomBytes(18).toString('base64url');
function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}

// ---------- Rooms ----------
function createRoom(isPrivate) {
  const room = {
    code: makeCode(), isPrivate, seats: [], game: null, state: 'waiting', winner: -1, deadline: 0,
    turnTimer: null, cpuTimer: null, events: [], rematch: new Set(), games: 0, seq: 0,
  };
  rooms.set(room.code, room);
  return room;
}
const seatOf = (room, client) => room.seats.find((s) => s.client === client);

// 손님마다 보내는 방 상태. 보드게임이라 판 위의 정보는 모두 공개이고, 섞인 황금열쇠 더미만 숨긴다
function snapshot(room, seat, events) {
  const g = room.game;
  const base = { code: room.code, you: seat.index, token: seat.token, state: room.state, games: room.games, host: room.seats[0] === seat, rematch: [...room.rematch], winner: room.winner, events: events || [] };
  if (!g) return { ...base, players: room.seats.map((s) => ({ name: s.name, online: s.online, human: true })), seats: room.seats.length };
  return {
    ...base,
    players: g.players.map((p, i) => ({ name: p.name, cash: p.cash, pos: p.pos, jailTurns: p.jailTurns, escape: p.escape, trip: p.trip, bankrupt: p.bankrupt, human: !!(room.seats[i] && !room.seats[i].gone && !room.seats[i].auto), online: !!(room.seats[i] && room.seats[i].online), auto: !!(room.seats[i] && room.seats[i].auto), cpu: i >= room.humans })),
    props: g.props, fund: g.fund, round: g.round, maxRounds: g.maxRounds, turn: g.turn, phase: g.phase, pending: g.pending, last: g.last,
    remain: room.state === 'playing' && g.players[g.turn].human ? Math.max(0, room.deadline - Date.now()) : 0,
  };
}
function pushRoom(room) {
  const events = room.events; room.events = [];
  for (const s of room.seats) if (s.online) send(s.client.ws, 'room', snapshot(room, s, events));
}
function collect(room) { const g = room.game; if (g && g.events.length) { room.events.push(...g.events); g.events = []; } }

function sitDown(room, client) {
  const seat = { client, name: client.name, index: room.seats.length, token: makeToken(), online: true, graceTimer: null, idle: 0, gone: false, auto: false };
  room.seats.push(seat);
  client.roomCode = room.code;
  if (!room.isPrivate && room.seats.length === 2) startGame(room);       // 빠른 대전은 둘이 모이면 바로
  else pushRoom(room);
}

function startGame(room) {
  room.seats = room.seats.filter((s) => !s.gone);
  room.seats.forEach((s, i) => { s.index = i; s.idle = 0; s.auto = false; });
  const humans = room.seats.length;
  if (humans < 2) return;
  room.humans = humans;
  const names = room.seats.map((s) => s.name);
  const spare = CPU_NAMES.filter((n) => !names.includes(n));
  while (names.length < MAX_SEATS) names.push(spare.shift() || `컴퓨터${names.length}`);
  const g = L.newGame(rand, { names, level: 'normal', first: room.games === 0 ? undefined : (room.first + 1) % MAX_SEATS });
  g.players.forEach((p, i) => { p.human = i < humans; });
  room.first = g.turn;
  room.game = g; room.state = 'playing'; room.winner = -1; room.events = []; room.rematch.clear(); room.games++;
  collect(room);
  tick(room);
}

// 다음에 일어날 일을 잡는다: 컴퓨터(또는 자리를 비운 사람) 차례면 잠시 뒤 스스로 움직이고, 사람 차례면 제한 시간을 잰다
function tick(room) {
  clearTimeout(room.turnTimer); clearTimeout(room.cpuTimer);
  const g = room.game;
  if (!g || room.state !== 'playing') return;
  if (g.phase === 'over') return endGame(room);
  const p = g.players[g.turn];
  if (!p.human) { room.deadline = 0; room.cpuTimer = setTimeout(() => cpuMove(room), CPU_MS); }
  else { room.deadline = Date.now() + TURN_MS; room.turnTimer = setTimeout(() => onTimeout(room), TURN_MS); }
  pushRoom(room);
}
function cpuMove(room) {
  if (room.state !== 'playing') return;
  L.cpuStep(room.game); collect(room);
  tick(room);
}
// 시간을 넘기면 컴퓨터가 한 번 대신 움직이고, 연달아 넘기면 그 사람의 자리는 컴퓨터가 맡는다
function onTimeout(room) {
  if (room.state !== 'playing') return;
  const g = room.game, p = g.players[g.turn], seat = room.seats[g.turn];
  if (!seat || !p.human) return tick(room);
  p.human = false; L.cpuStep(g); p.human = true;
  seat.idle++;
  if (seat.idle >= MAX_IDLE) { seat.auto = true; p.human = false; }
  collect(room);
  tick(room);
}
function endGame(room) {
  if (room.state !== 'playing') return;
  clearTimeout(room.turnTimer); clearTimeout(room.cpuTimer);
  room.state = 'over'; room.winner = room.game.winner;
  pushRoom(room);
}
function closeRoom(room) {
  clearTimeout(room.turnTimer); clearTimeout(room.cpuTimer);
  for (const s of room.seats) { clearTimeout(s.graceTimer); if (s.client) s.client.roomCode = null; }
  rooms.delete(room.code);
}
// 사람이 자리를 떠난다: 대국 중이면 그 자리는 컴퓨터가 이어받는다
function vacate(room, seat) {
  clearTimeout(seat.graceTimer);
  const wasHost = room.seats[0] === seat;
  if (room.state === 'playing') {
    seat.gone = true; seat.online = false; if (seat.client) seat.client.roomCode = null; seat.client = null;
    const p = room.game.players[seat.index]; if (p) p.human = false;
    if (room.seats.every((s) => s.gone || s.auto)) { closeRoom(room); return; }
    tick(room); return;
  }
  if (room.state === 'waiting') {
    if (wasHost) { for (const s of room.seats) if (s !== seat && s.online) { send(s.client.ws, 'error', { msg: '방장이 나가서 방이 닫혔어요.' }); } closeRoom(room); return; }
    room.seats = room.seats.filter((s) => s !== seat);
    room.seats.forEach((s, i) => { s.index = i; });
    if (seat.client) seat.client.roomCode = null;
    pushRoom(room); return;
  }
  seat.gone = true; seat.online = false; if (seat.client) seat.client.roomCode = null; seat.client = null;     // over
  room.rematch.delete(seat.index);
  if (room.seats.every((s) => s.gone)) { closeRoom(room); return; }
  pushRoom(room);
}
const dropFromQueue = (client) => { if (queue === client) queue = null; };

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) { client.name = sanitizeName(msg.name); },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue; queue = null;
      const room = createRoom(false);
      sitDown(room, other); sitDown(room, client);
    } else { queue = client; send(client.ws, 'queued'); }
  },
  create(client) { if (client.roomCode) return; dropFromQueue(client); sitDown(createRoom(true), client); },
  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    if (joinBlocked(client.ip)) return send(client.ws, 'error', { msg: '방 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.' });
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) { noteJoinFail(client.ip); return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' }); }
    if (room.state !== 'waiting') return send(client.ws, 'error', { msg: '이미 시작한 방이에요.' });
    if (room.seats.length >= MAX_SEATS) return send(client.ws, 'error', { msg: '방이 가득 찼어요. (최대 4명)' });
    sitDown(room, client);
  },
  start(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'waiting' || room.seats[0] !== seat || room.seats.length < 2) return;
    startGame(room);
  },
  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const seat = room && room.seats.find((s) => s.token === msg.token && !s.gone);
    if (!seat) return send(client.ws, 'resumeFailed');
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 대국에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client; seat.online = true; client.name = seat.name; client.roomCode = room.code;
    if (seat.auto && room.state === 'playing') { seat.auto = false; seat.idle = 0; const p = room.game.players[seat.index]; if (p) p.human = true; }
    if (room.state === 'playing') tick(room); else pushRoom(room);
  },
  cancel(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'waiting') vacate(room, seat);
  },

  // 내 차례에 할 수 있는 일: 규칙에 어긋나면 L 의 함수가 거절한다
  act(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    const g = room && room.game;
    if (!seat || room.state !== 'playing' || g.turn !== seat.index || !g.players[seat.index].human) return;
    let ok = false;
    switch (msg.type) {
      case 'roll': ok = L.roll(g); break;
      case 'buy': ok = L.buy(g); break;
      case 'build': ok = L.build(g); break;
      case 'skip': ok = L.skip(g); break;
      case 'payJail': ok = L.payJail(g); break;
      case 'escape': ok = L.useEscape(g); break;
      case 'space': ok = Number.isInteger(msg.tile) && L.chooseSpace(g, msg.tile); break;
      default: return;
    }
    if (!ok) return;
    seat.idle = 0;
    collect(room);
    tick(room);
  },

  rematch(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'over') return;
    room.rematch.add(seat.index);
    const stay = room.seats.filter((s) => !s.gone);
    if (stay.length >= 2 && stay.every((s) => room.rematch.has(s.index))) startGame(room);
    else pushRoom(room);
  },
  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) vacate(room, seat);
  },
  pulse() {},
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const seat = room && seatOf(room, client);
  if (!seat) return;
  if (room.state !== 'playing') { vacate(room, seat); return; }
  seat.online = false; seat.client = null;
  seat.graceTimer = setTimeout(() => vacate(room, seat), GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => { for (const ws of wss.clients) ws.ping(); }, HEARTBEAT_MS);
const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
}, 5000);
wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});
  const client = { id: nextId++, ws, ip: clientIp(req), name: sanitizeName(''), roomCode: null, lastSeen: Date.now() };
  clients.set(ws, client);
  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && typeof msg.t === 'string' && Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (handler) handler(client, msg);
  });
  ws.on('close', () => { onDisconnect(client); clients.delete(ws); });
});

server.listen(PORT, () => { console.log(`세계 일주 보드게임 서버 실행 중 → http://localhost:${PORT}`); });
