import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'server-config.json');
const CLAIMS_FILE = path.join(DATA_DIR, 'legendary-claims.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const defaults = {
  port: 10000,
  world: {
    mapWidth: 80,
    mapHeight: 50,
    maps: ['sea','beach','grass','forest','mountain','cave','elf','lab','winter','cemetery','murim','power','volcano','wasteland','abyss','polluted','desert']
  },
  limits: {
    maxPlayers: 100,
    maxPayloadBytes: 65536,
    statePerSecond: 20,
    chatPer5Seconds: 6,
    claimPer5Seconds: 8,
    battleRequestPer10Seconds: 4,
    sameMapBattleDistance: 3,
    maxSameMapStateJump: 6,
    battleOfferTtlMs: 30000,
    pingIntervalMs: 25000,
    idleGraceMs: 70000
  }
};

const userConfig = readJson(CONFIG_FILE, {});
const CONFIG = {
  ...defaults,
  ...userConfig,
  world: { ...defaults.world, ...(userConfig.world || {}) },
  limits: { ...defaults.limits, ...(userConfig.limits || {}) }
};
const PORT = Number(process.env.PORT || CONFIG.port || 10000);
const MAPS = new Set(CONFIG.world.maps);
const MAP_W = Number(CONFIG.world.mapWidth) || 80;
const MAP_H = Number(CONFIG.world.mapHeight) || 50;

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const storedClaims = readJson(CLAIMS_FILE, {});
const legendaryClaims = new Map(
  Object.entries(storedClaims || {}).filter(([id, c]) => c && typeof c === 'object' && typeof c.playerId === 'string')
);

// Sessions are live only. Progression remains on each player's own device.
const players = new Map();
const battleRequests = new Map(); // targetId -> {fromId, expiresAt}
const battleSessions = new Map(); // pairKey -> {requesterId, accepterId, expiresAt}

function validId(v) {
  return typeof v === 'string' && /^[a-z0-9-]{16,64}$/i.test(v);
}
function sanitizeNick(v) {
  const s = String(v ?? '').trim().replace(/[\u0000-\u001F\u007F]/g, '');
  return s.slice(0, 16) || '플레이어';
}
function validDir(v) {
  return v === 'up' || v === 'down' || v === 'left' || v === 'right';
}
function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function clampCoord(v, max) {
  return Math.max(0, Math.min(max - 1, v));
}
function validMap(v) {
  return typeof v === 'string' && MAPS.has(v);
}
function distance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}
function pairKey(a, b) {
  return [a, b].sort().join('|');
}
function playerSnapshot(p) {
  return { id: p.id, nick: p.nick, map: p.map, x: p.x, y: p.y, dir: p.dir };
}
function worldSnapshot() {
  const out = {};
  for (const [id, p] of players) out[id] = playerSnapshot(p);
  return out;
}
function send(p, obj) {
  if (p?.ws?.readyState !== 1) return false;
  try {
    p.ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}
function broadcast(obj, exceptId = null) {
  const text = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId || p.ws.readyState !== 1) continue;
    try { p.ws.send(text); } catch {}
  }
}
function persistClaims() {
  atomicWriteJson(CLAIMS_FILE, Object.fromEntries(legendaryClaims));
}
function persistKnownPlayer(p) {
  try {
    const known = readJson(PLAYERS_FILE, {});
    known[p.id] = { id: p.id, nick: p.nick, lastSeen: Date.now() };
    atomicWriteJson(PLAYERS_FILE, known);
  } catch {}
}
function consumeRate(p, bucket, limit, windowMs) {
  const now = Date.now();
  p.rate ||= {};
  const b = p.rate[bucket] ||= { start: now, count: 0 };
  if (now - b.start >= windowMs) {
    b.start = now;
    b.count = 0;
  }
  b.count += 1;
  return b.count <= limit;
}
function messageTooLarge(buf) {
  return !Buffer.isBuffer(buf) || buf.byteLength > CONFIG.limits.maxPayloadBytes;
}
function cleanupExpiredBattleData() {
  const now = Date.now();
  for (const [id, req] of battleRequests) if (req.expiresAt <= now) battleRequests.delete(id);
  for (const [k, session] of battleSessions) if (session.expiresAt <= now) battleSessions.delete(k);
}

function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0] || '/'); } catch { return null; }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  const root = path.resolve(PUBLIC_DIR);
  return file === root || file.startsWith(`${root}${path.sep}`) ? file : null;
}
function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  if (req.url === '/health') {
    const body = JSON.stringify({ ok: true, players: players.size, claims: legendaryClaims.size, uptime: process.uptime() });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  const file = safeStaticPath(req.url || '/');
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

const httpServer = http.createServer(serve);
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: CONFIG.limits.maxPayloadBytes,
  perMessageDeflate: false
});

wss.on('connection', ws => {
  let current = null;
  let alive = true;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const reject = (code, message = '요청을 처리할 수 없습니다.') => {
    try { send(current, { t: 'error', code, message }); } catch {}
  };

  ws.on('message', (buf, isBinary) => {
    if (messageTooLarge(buf)) {
      try { ws.close(1009, 'message too large'); } catch {}
      return;
    }
    if (isBinary) return;

    let d;
    try { d = JSON.parse(buf.toString('utf8')); } catch { reject('BAD_JSON', '잘못된 메시지 형식입니다.'); return; }
    if (!d || typeof d.t !== 'string' || d.t.length > 32) return;

    if (d.t === 'join') {
      if (current) return;
      if (players.size >= Number(CONFIG.limits.maxPlayers)) {
        try { send({ ws }, { t: 'error', code: 'SERVER_FULL', message: '서버가 가득 찼습니다.' }); } catch {}
        try { ws.close(1013, 'server full'); } catch {}
        return;
      }
      if (!validId(d.id) || !validMap(d.map) || !finiteNumber(d.x) || !finiteNumber(d.y) || !validDir(d.dir)) {
        try { ws.close(1008, 'invalid join'); } catch {}
        return;
      }

      const existing = players.get(d.id);
      if (existing && existing.ws !== ws) {
        // Reconnecting with the same stable client ID replaces the stale session.
        try { existing.ws.close(4001, 'reconnected'); } catch {}
        players.delete(d.id);
      }

      current = {
        id: d.id,
        nick: sanitizeNick(d.nick),
        map: d.map,
        x: clampCoord(d.x, MAP_W),
        y: clampCoord(d.y, MAP_H),
        dir: d.dir,
        ws,
        lastSeen: Date.now(),
        rate: {}
      };
      players.set(current.id, current);
      persistKnownPlayer(current);
      send(current, { t: 'welcome', claimed: Object.fromEntries(legendaryClaims), self: playerSnapshot(current) });
      send(current, { t: 'players', players: worldSnapshot() });
      broadcast({ t: 'playerJoin', player: playerSnapshot(current) }, current.id);
      return;
    }

    if (!current) {
      reject('NOT_JOINED', '먼저 멀티플레이에 접속해야 합니다.');
      return;
    }
    current.lastSeen = Date.now();

    if (d.t === 'state') {
      if (!consumeRate(current, 'state', Number(CONFIG.limits.statePerSecond), 1000)) return;
      const nextMap = d.map;
      const nextX = Number(d.x);
      const nextY = Number(d.y);
      const nextDir = d.dir;
      if (!validMap(nextMap) || !finiteNumber(nextX) || !finiteNumber(nextY) || !validDir(nextDir)) return;

      const nx = clampCoord(nextX, MAP_W);
      const ny = clampCoord(nextY, MAP_H);
      const mapChanged = nextMap !== current.map;
      if (!mapChanged && Math.hypot(nx - current.x, ny - current.y) > Number(CONFIG.limits.maxSameMapStateJump)) {
        reject('STATE_JUMP', '비정상적인 위치 이동이 감지되었습니다.');
        return;
      }

      current.nick = sanitizeNick(d.nick || current.nick);
      current.map = nextMap;
      current.x = nx;
      current.y = ny;
      current.dir = nextDir;
      broadcast({ t: 'players', players: worldSnapshot() });
      return;
    }

    if (d.t === 'chat') {
      if (!consumeRate(current, 'chat', Number(CONFIG.limits.chatPer5Seconds), 5000)) {
        reject('CHAT_RATE', '채팅을 너무 빠르게 보낼 수 없습니다.');
        return;
      }
      const text = String(d.text ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120);
      if (!text) return;
      broadcast({ t: 'chat', id: current.id, nick: current.nick, text });
      return;
    }

    if (d.t === 'claimLegendary') {
      if (!consumeRate(current, 'claim', Number(CONFIG.limits.claimPer5Seconds), 5000)) return reject('CLAIM_RATE', '기믹 요청이 너무 빠릅니다.');
      const eventId = String(d.eventId ?? '').trim();
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(eventId)) return reject('BAD_EVENT', '잘못된 기믹 ID입니다.');
      cleanupExpiredBattleData();
      const already = legendaryClaims.get(eventId);
      if (already) {
        send(current, { t: 'claimResult', granted: false, eventId, name: eventId, claim: already });
        return;
      }
      // This Map update is synchronous and therefore atomic within this Node process.
      const claim = {
        playerId: current.id,
        nick: current.nick,
        mode: String(d.mode ?? 'defeated').slice(0, 32),
        claimedAt: Date.now()
      };
      legendaryClaims.set(eventId, claim);
      persistClaims();
      send(current, { t: 'claimResult', granted: true, eventId, name: eventId, claim, mode: claim.mode });
      broadcast({ t: 'claims', claimed: Object.fromEntries(legendaryClaims) }, current.id);
      return;
    }

    if (d.t === 'resetLegendaryClaims') {
      // Never trust d.id here: the connection identity is authoritative.
      let changed = false;
      for (const [eventId, claim] of [...legendaryClaims]) {
        if (claim?.playerId === current.id) {
          legendaryClaims.delete(eventId);
          changed = true;
        }
      }
      if (changed) persistClaims();
      const snapshot = Object.fromEntries(legendaryClaims);
      broadcast({ t: 'claimsReset', claimed: snapshot });
      return;
    }

    if (d.t === 'battleRequest') {
      if (!consumeRate(current, 'battleRequest', Number(CONFIG.limits.battleRequestPer10Seconds), 10000)) {
        reject('BATTLE_RATE', '배틀 신청을 너무 빠르게 보낼 수 없습니다.');
        return;
      }
      cleanupExpiredBattleData();
      const targetId = String(d.to ?? '');
      const target = players.get(targetId);
      if (!target || target.id === current.id) return reject('BAD_TARGET', '상대 플레이어를 찾을 수 없습니다.');
      if (target.map !== current.map || distance(target, current) > Number(CONFIG.limits.sameMapBattleDistance)) {
        return reject('TOO_FAR', '배틀 신청은 가까운 플레이어에게만 할 수 있습니다.');
      }
      battleRequests.set(target.id, { fromId: current.id, expiresAt: Date.now() + Number(CONFIG.limits.battleOfferTtlMs) });
      send(target, { t: 'battleOffer', from: current.id, fromNick: current.nick, to: target.id });
      return;
    }

    if (d.t === 'battleAccept') {
      cleanupExpiredBattleData();
      const requesterId = String(d.to ?? '');
      const requester = players.get(requesterId);
      const pending = battleRequests.get(current.id);
      if (!requester || !pending || pending.fromId !== requesterId) return reject('BAD_BATTLE_ACCEPT', '유효한 배틀 신청이 없습니다.');
      battleRequests.delete(current.id);
      const key = pairKey(requesterId, current.id);
      battleSessions.set(key, {
        requesterId,
        accepterId: current.id,
        expiresAt: Date.now() + Number(CONFIG.limits.battleOfferTtlMs)
      });
      // The requester hosts the existing PeerJS battle, exactly as the HTML expects.
      send(requester, { t: 'battleAccepted', from: current.id, fromNick: current.nick, to: requester.id, acceptedBy: current.id, role: 'host' });
      return;
    }

    if (d.t === 'battleReject') {
      const requesterId = String(d.to ?? '');
      const requester = players.get(requesterId);
      const pending = battleRequests.get(current.id);
      if (pending?.fromId === requesterId) battleRequests.delete(current.id);
      if (requester) send(requester, { t: 'battleRejected', from: current.id, fromNick: current.nick });
      return;
    }

    if (d.t === 'battlePeerReady') {
      cleanupExpiredBattleData();
      const targetId = String(d.to ?? '');
      const target = players.get(targetId);
      const code = String(d.peerCode ?? '').trim().toUpperCase();
      const session = battleSessions.get(pairKey(current.id, targetId));
      if (!target || !session || session.requesterId !== current.id || session.accepterId !== targetId) return;
      if (!/^[A-Z0-9_-]{4,80}$/.test(code)) return reject('BAD_PEER_CODE', '잘못된 배틀 연결 코드입니다.');
      send(target, { t: 'battlePeerReady', from: current.id, fromNick: current.nick, to: target.id, peerCode: code });
      battleSessions.delete(pairKey(current.id, targetId));
      return;
    }

    // Unknown message types are ignored deliberately for forward compatibility.
  });

  ws.on('close', () => {
    if (!current) return;
    const live = players.get(current.id);
    // An older connection must not delete a newer reconnecting session.
    if (live?.ws === ws) players.delete(current.id);
    for (const [id, req] of battleRequests) if (req.fromId === current.id || id === current.id) battleRequests.delete(id);
    for (const [k, s] of battleSessions) if (s.requesterId === current.id || s.accepterId === current.id) battleSessions.delete(k);
    if (live?.ws === ws) broadcast({ t: 'playerLeave', id: current.id });
  });

  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  cleanupExpiredBattleData();
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, Number(CONFIG.limits.pingIntervalMs));
heartbeat.unref?.();

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Rain Matic multiplayer server listening on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
  console.log(`Players max: ${CONFIG.limits.maxPlayers}, maps: ${MAPS.size}, legendary claims: ${legendaryClaims.size}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) { try { ws.close(1001, 'server shutdown'); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
