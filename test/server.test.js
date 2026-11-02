'use strict';

// 서버 시험: 보안·안정성 + 세계 일주 온라인 대국 흐름 (빠른 대전, 방 코드, 컴퓨터 채우기, 시간 초과, 재접속)
// 실행: node --test  (Node 18 이상, ws 필요: npm install)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

// 운영체제가 지금 비어 있는 포트를 골라 준다
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), TURN_MS: '600', CPU_MS: '15', GRACE_MS: '700' }, stdio: 'ignore' });
child.unref();
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

const open = (name) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, name, msgs: [], room: null, queued: false, errors: [], closed: null, events: [] };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    c.msgs.push(m);
    if (m.t === 'room') { c.room = m; c.events.push(...(m.events || [])); }
    if (m.t === 'queued') c.queued = true;
    if (m.t === 'error') c.errors.push(m.msg);
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => { if (name) ws.send(JSON.stringify({ t: 'hello', name })); resolve(c); });
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});
const send = (c, t, p = {}) => c.ws.send(JSON.stringify({ t, ...p }));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
const closeAll = (...cs) => cs.forEach((c) => c.ws.close());

async function pair() {
  const a = await open('가'), b = await open('나');
  send(a, 'quick'); await until(() => a.queued);
  send(b, 'quick');
  assert.ok(await until(() => a.room && b.room && a.room.state === 'playing' && b.room.state === 'playing'), 'quick match starts at once');
  return [a, b];
}
async function lobby(n) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(await open('p' + i));
  send(cs[0], 'create');
  assert.ok(await until(() => cs[0].room && cs[0].room.code));
  const code = cs[0].room.code;
  for (let i = 1; i < n; i++) send(cs[i], 'join', { code });
  assert.ok(await until(() => cs.every((c) => c.room && c.room.players.length === n)), 'everyone seated');
  return { cs, code };
}
const myTurn = (c) => c.room && c.room.state === 'playing' && c.room.turn === c.room.you && c.room.players[c.room.you].human;

test('the server serves the page but never files outside public', async () => {
  await ready;
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/game.js'), 200);
  assert.strictEqual(await get('/logic.js'), 200);
  assert.strictEqual(await get('/server.js'), 404);
  assert.strictEqual(await get('/..%2fserver.js'), 403);
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/.env'), 403);
});

test('a huge message or bad JSON does not crash the server', async () => {
  await ready;
  const a = await open('x');
  a.ws.send('{not json');
  a.ws.send(JSON.stringify({ t: '__proto__' })); a.ws.send(JSON.stringify({ t: 'constructor' })); a.ws.send(JSON.stringify({ t: 'act', type: 'roll' }));
  a.ws.send('x'.repeat(5000));
  assert.ok(await until(() => a.closed !== null), 'oversized message closes only that connection');
  assert.strictEqual(await get('/'), 200);
});

test('quick match: two people are seated with two computers, hosts and seat numbers are right', async () => {
  await ready;
  const [a, b] = await pair();
  assert.strictEqual(a.room.players.length, 4); assert.strictEqual(b.room.players.length, 4);
  assert.deepStrictEqual([a.room.you, b.room.you], [0, 1]);
  assert.deepStrictEqual(a.room.players.map((p) => p.cpu), [false, false, true, true]);
  assert.deepStrictEqual(a.room.players.map((p) => p.name).slice(0, 2), ['가', '나']);
  assert.ok(a.room.players.slice(2).every((p) => /^[가-힣]+$/.test(p.name)));
  assert.ok(a.room.players.every((p) => p.cash === 200));
  assert.strictEqual(a.room.maxRounds, 30);
  closeAll(a, b);
});

test('room codes: create, join, a wrong code, only the host can start, at least 2 people, at most 4', async () => {
  await ready;
  const { cs, code } = await lobby(3);
  assert.strictEqual(cs[0].room.host, true); assert.strictEqual(cs[1].room.host, false);
  const x = await open('x'); send(x, 'join', { code: 'ZZZZ' });
  assert.ok(await until(() => x.errors.length === 1));
  send(cs[1], 'start'); await sleep(100); assert.strictEqual(cs[0].room.state, 'waiting', 'a guest cannot start');
  const d = await open('d'); send(d, 'join', { code });
  assert.ok(await until(() => cs[0].room.players.length === 4));
  const e = await open('e'); send(e, 'join', { code });
  assert.ok(await until(() => e.errors.length === 1), 'a fifth person is turned away');
  send(cs[0], 'start');
  assert.ok(await until(() => cs[0].room.state === 'playing'));
  assert.deepStrictEqual(cs[0].room.players.map((p) => p.cpu), [false, false, false, false]);
  const solo = await open('solo'); send(solo, 'create'); assert.ok(await until(() => solo.room));
  send(solo, 'start'); await sleep(100); assert.strictEqual(solo.room.state, 'waiting', 'one person cannot start');
  closeAll(...cs, x, d, e, solo);
});

test('only the player whose turn it is can act; a roll produces dice and a move', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => myTurn(a) || myTurn(b)), 'a human gets a turn (computers may go first)');
  const first = myTurn(a) ? a : b, second = first === a ? b : a;
  send(second, 'act', { type: 'roll' }); await sleep(100);
  assert.ok(!second.events.some((e) => e.t === 'dice' && e.who === second.room.you), 'out of turn is ignored');
  const before = first.events.length;
  send(first, 'act', { type: 'roll' });
  assert.ok(await until(() => first.events.slice(before).some((e) => e.t === 'dice')));
  assert.ok(await until(() => first.events.slice(before).some((e) => e.t === 'move')));
  const d = first.events.find((e) => e.t === 'dice' && e.who === first.room.you);
  assert.ok(d && d.a >= 1 && d.a <= 6 && d.b >= 1 && d.b <= 6);
  closeAll(a, b);
});

test('the computers play on their own and the game keeps moving', async () => {
  await ready;
  const [a, b] = await pair();
  // 두 사람이 계속 굴리거나 사거나 건너뛰며 컴퓨터 차례가 지나가는 것을 본다
  const t0 = Date.now(); let cpuMoves = 0;
  while (Date.now() - t0 < 4000 && cpuMoves < 6) {
    for (const c of [a, b]) {
      if (myTurn(c)) {
        const g = c.room;
        send(c, 'act', { type: g.phase === 'roll' ? 'roll' : g.phase === 'decide' ? (g.pending.type === 'buy' ? 'buy' : 'skip') : 'space', tile: 3 });
      }
    }
    cpuMoves = a.events.filter((e) => e.t === 'dice' && e.who >= 2).length;
    await sleep(20);
  }
  assert.ok(cpuMoves >= 6, 'computers rolled by themselves: ' + cpuMoves);
  closeAll(a, b);
});

test('timeouts: a silent player is played by the computer for a turn, and after three in a row for good', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => a.room.players.some((p) => p.auto) || b.room.players.some((p) => p.auto), 12000), 'someone became automatic after repeated timeouts');
  const idle = a.room.players.findIndex((p) => p.auto);
  assert.ok(idle >= 0 || b.room.players.some((p) => p.auto));
  const before = a.events.length;
  assert.ok(await until(() => a.events.length > before + 8), 'the game keeps moving without them');
  closeAll(a, b);
});

test('a dropped player can come back to the same seat with the saved key', async () => {
  await ready;
  const [a, b] = await pair();
  const code = a.room.code, token = a.room.token, you = a.room.you;
  a.ws.close();
  assert.ok(await until(() => b.room.players[you].online === false), 'the other side sees the drop');
  const a2 = await open('가'); send(a2, 'resume', { code, token });
  assert.ok(await until(() => a2.room && a2.room.you === you && a2.room.state === 'playing'));
  assert.ok(await until(() => b.room.players[you].online === true));
  const bad = await open('도둑'); send(bad, 'resume', { code, token: 'wrong' });
  assert.ok(await until(() => bad.msgs.some((m) => m.t === 'resumeFailed')));
  closeAll(a2, b, bad);
});

test('leaving mid-game hands the seat to a computer and the others play on; an empty room closes', async () => {
  await ready;
  const { cs, code } = await lobby(3);
  send(cs[0], 'start'); assert.ok(await until(() => cs[0].room.state === 'playing'));
  send(cs[2], 'leave');
  assert.ok(await until(() => cs[0].room.players[2].human === false), 'seat 2 is now a computer');
  const n0 = cs[0].events.length;
  assert.ok(await until(() => cs[0].events.length > n0 + 5), 'the game continues');
  send(cs[0], 'leave'); send(cs[1], 'leave');
  await sleep(150);
  const z = await open('z'); send(z, 'join', { code });
  assert.ok(await until(() => z.errors.length === 1), 'the empty room is gone');
  closeAll(...cs, z);
});

test('a whole game finishes and a rematch needs everyone', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => a.room.state === 'over' || b.room.state === 'over', 40000), 'the game ends (silent humans become automatic)');
  assert.ok(await until(() => a.room.state === 'over'));
  assert.ok(a.room.winner >= 0 && a.room.winner < 4);
  send(a, 'rematch'); await sleep(100);
  assert.strictEqual(a.room.state, 'over', 'waits for the other player');
  send(b, 'rematch');
  assert.ok(await until(() => a.room.state === 'playing' && a.room.games === 2), 'a new game starts');
  closeAll(a, b);
});

test('guessing room codes too often is blocked for a while', async () => {
  await ready;
  const x = await open('bruteforce');
  for (let i = 0; i < 9; i++) { send(x, 'join', { code: 'AAA' + i }); await sleep(10); }
  assert.ok(await until(() => x.errors.some((e) => /너무 많이/.test(e))), 'blocked after repeated misses');
  closeAll(x);
});
