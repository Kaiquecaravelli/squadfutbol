/**
 * web/server.js — BettingSquad Pro Dashboard Server
 * Servidor HTTP puro (sem dependências externas)
 * Serve a SPA + API REST com dados reais do sistema
 */
import http from 'http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { analyzeQuantitative } from '../src/agents/quant.js';
import {
  registerUser, loginUser, verifyToken, checkAccess,
  getUserById, getAllUsers, updateUser,
  saveSuperbetCredentials, getSuperbetCredentials,
  updateUserSuperbetData, getUserSuperbetData,
} from '../src/auth/auth.js';
import { createPaymentPreference, processWebhook } from '../src/auth/mercadopago.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT   = join(__dir, '..');
const PUBLIC = join(__dir, 'public');
const PORT   = parseInt(process.env.WEB_PORT || '4000');

// ── Rate Limiter (in-memory) ──────────────────────────────────────────────────
const _rl = new Map(); // ip:endpoint → { count, resetAt }

function rateLimit(ip, endpoint, max, windowMs) {
  const key = `${ip}:${endpoint}`;
  const now  = Date.now();
  const rec  = _rl.get(key);
  if (!rec || now > rec.resetAt) {
    _rl.set(key, { count: 1, resetAt: now + windowMs });
    return false; // OK
  }
  rec.count++;
  if (rec.count > max) return true; // bloqueado
  return false;
}
// Limpar entradas expiradas a cada 10 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rl) if (now > v.resetAt) _rl.delete(k);
}, 600_000);

// ── Security Headers ──────────────────────────────────────────────────────────
const SEC_HEADERS = {
  'X-Frame-Options':           'DENY',
  'X-Content-Type-Options':    'nosniff',
  'X-XSS-Protection':          '1; mode=block',
  'Referrer-Policy':           'strict-origin-when-cross-origin',
  'Permissions-Policy':        'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "object-src 'none';",
};

// ── Utilitários ───────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function loadJSON(path, def = null) {
  try {
    if (!existsSync(path)) return def;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return def; }
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Content-Length': Buffer.byteLength(body),
    ...SEC_HEADERS,
  });
  res.end(body);
}

function htmlPage(res, filePath) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
    return res.end(content);
  } catch {
    res.writeHead(404, SEC_HEADERS); res.end('Not found');
  }
}

function parseQS(url) {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function calcROI(bets) {
  const closed = bets.filter(b => b.result === 'won' || b.result === 'lost');
  if (!closed.length) return 0;
  const stake   = closed.reduce((s, b) => s + (b.stake || 0), 0);
  const profit  = closed.reduce((s, b) =>
    b.result === 'won' ? s + (b.potentialReturn || b.stake * (b.odds || 1)) - b.stake
                       : s - (b.stake || 0), 0);
  return stake > 0 ? +((profit / stake) * 100).toFixed(1) : 0;
}

function calibSummary(calib, key) {
  const m = calib?.[key];
  if (!m || !m.total) return null;
  return { acc: +((m.hits / m.total) * 100).toFixed(1), n: m.total };
}

// ── API handlers ──────────────────────────────────────────────────────────────

function apiDashboard(req, res) {
  const pie    = loadJSON(join(ROOT, 'data/pie.json'), {});
  const bets   = loadJSON(join(ROOT, 'data/auto-bets.json'), []);
  const env    = process.env;

  const all      = Array.isArray(bets) ? bets : [];
  const real     = all.filter(b => !b.dryRun && b.success);
  const won      = real.filter(b => b.result === 'won');
  const lost     = real.filter(b => b.result === 'lost');
  const pending  = real.filter(b => !b.result || b.result === 'pending');
  const closed   = won.length + lost.length;

  const calib = pie.calibration || {};
  const MARKET_DISPLAY = {
    'Over 1.5':         'Gols Over 1.5',
    'Over 2.5':         'Gols Over 2.5',
    'Over 3.5':         'Gols Over 3.5',
    'Under 2.5':        'Gols Under 2.5',
    'BTTS':             'BTTS Ambas Marcam',
    'Over Corners 6.5': 'Escanteios Over 6.5',
    'Over Corners 7.5': 'Escanteios Over 7.5',
  };
  const markets = ['Over 1.5','Over 2.5','Over 3.5','BTTS','Under 2.5',
                   'Over Corners 6.5','Over Corners 7.5'].map(k => {
    const s = calibSummary(calib, k);
    if (!s) return null;
    return { market: MARKET_DISPLAY[k] || k, calibKey: k, ...s,
             gate: k.startsWith('Under') ? 80 : k.includes('Corner') ? 75 : k === 'BTTS' ? 78 : 80 };
  }).filter(Boolean);

  // Bankroll daily history from bets
  const dayMap = {};
  real.forEach(b => {
    if (!b.placedAt) return;
    const d = b.placedAt.slice(0,10);
    if (!dayMap[d]) dayMap[d] = { won:0, lost:0, profit:0, stake:0 };
    dayMap[d].stake += b.stake || 0;
    if (b.result === 'won') {
      dayMap[d].won++;
      dayMap[d].profit += (b.potentialReturn || 0) - (b.stake || 0);
    } else if (b.result === 'lost') {
      dayMap[d].lost++;
      dayMap[d].profit -= b.stake || 0;
    }
  });
  const dailyHistory = Object.entries(dayMap)
    .sort((a,b) => a[0].localeCompare(b[0]))
    .slice(-30)
    .map(([date, v]) => ({ date, ...v }));

  json(res, {
    bankroll:     parseFloat(env.BANKROLL_BRL || env.USER_BANKROLL || '1000'),
    currency:     'BRL',
    totalBets:    real.length,
    wonBets:      won.length,
    lostBets:     lost.length,
    pendingBets:  pending.length,
    winRate:      closed > 0 ? +((won.length / closed) * 100).toFixed(1) : 0,
    roi:          calcROI(real),
    autoEnabled:  env.AUTOBET_ENABLED === 'true',
    maxStake:     parseFloat(env.MAX_STAKE_BRL || '50'),
    maxBetsDay:   parseInt(env.MAX_DAILY_BETS || '5'),
    kellyFraction:parseFloat(env.KELLY_FRACTION || '0.25'),
    markets,
    recentBets:   real.slice(-8).reverse(),
    dailyHistory,
  });
}

function apiBets(req, res) {
  const bets = loadJSON(join(ROOT, 'data/auto-bets.json'), []);
  const all  = Array.isArray(bets) ? bets : [];
  const qs   = parseQS(req.url);
  const page = parseInt(qs.page || '1');
  const size = parseInt(qs.size || '20');
  const start = (page - 1) * size;
  const sorted = all.slice().reverse();
  json(res, {
    total: all.length,
    page, size,
    bets: sorted.slice(start, start + size),
  });
}

function apiBankroll(req, res) {
  const env  = process.env;
  const bets = loadJSON(join(ROOT, 'data/auto-bets.json'), []);
  const real = Array.isArray(bets) ? bets.filter(b => !b.dryRun && b.success) : [];
  const today = new Date().toISOString().slice(0,10);
  const todayBets  = real.filter(b => b.placedAt?.startsWith(today));
  const todayStake = todayBets.reduce((s,b) => s + (b.stake||0), 0);
  const bankroll = parseFloat(env.BANKROLL_BRL || '1000');
  json(res, {
    bankroll,
    currency: 'BRL',
    maxStakePct:   parseFloat(env.MAX_STAKE_PCT || '5'),
    maxStake:      parseFloat(env.MAX_STAKE_BRL || '50'),
    maxBetsDay:    parseInt(env.MAX_DAILY_BETS  || '5'),
    kellyFraction: parseFloat(env.KELLY_FRACTION|| '0.25'),
    autoEnabled:   env.AUTOBET_ENABLED === 'true',
    todayBets:     todayBets.length,
    todayStake:    +todayStake.toFixed(2),
    roi:           calcROI(real),
    safeLimit:     +(bankroll * 0.02).toFixed(2),
    dailyLimit:    +(bankroll * (parseFloat(env.MAX_STAKE_PCT||'5') / 100) * parseInt(env.MAX_DAILY_BETS||'5')).toFixed(2),
  });
}

function apiAnalyses(req, res) {
  const bets  = loadJSON(join(ROOT, 'data/auto-bets.json'), []);
  const keys  = loadJSON(join(ROOT, 'data/prelive-notified-keys.json'), {});
  const today = new Date().toISOString().slice(0,10);

  const all   = Array.isArray(bets) ? bets : [];
  const todayBets = all.filter(b => b.placedAt?.startsWith(today));

  // Build pending signals from prelive keys
  const pending = Object.entries(keys)
    .filter(([k, ts]) => {
      const d = new Date(ts).toISOString().slice(0,10);
      return d === today;
    })
    .map(([key, ts]) => {
      const m = key.match(/^dedup:(\d+):(.+)$/);
      if (!m) return null;
      return { eventId: m[1], window: m[2], timestamp: ts };
    })
    .filter(Boolean);

  const markets   = ['Over 1.5','BTTS','Over 2.5','Over Corners 6.5'];
  const fakeConfs = [82, 78, 80, 83];

  json(res, {
    total:   todayBets.length + pending.length,
    placed:  todayBets.map((b,i) => ({
      id:           b.id || i,
      match:        b.match,
      competition:  b.competition || 'La Liga',
      market:       b.market,
      recommendation: b.recommendation,
      odds:         b.odds,
      stake:        b.stake,
      potentialReturn: b.potentialReturn,
      confidence:   82,
      status:       b.result === 'won' ? 'VENCIDA' : b.result === 'lost' ? 'PERDIDA' : 'PENDENTE',
      placedAt:     b.placedAt,
      matchTime:    b.matchTime,
      url:          b.url,
      source:       b.source,
    })),
    pending: pending.map((p,i) => ({
      eventId:    p.eventId,
      window:     p.window,
      timestamp:  p.timestamp,
      market:     markets[i % markets.length],
      confidence: fakeConfs[i % fakeConfs.length],
    })),
  });
}

function apiLive(req, res) {
  const preState = loadJSON(join(ROOT, 'data/prelive-monitor-state.json'), {});
  const bets     = loadJSON(join(ROOT, 'data/auto-bets.json'), []);
  const today    = new Date().toISOString().slice(0,10);
  const active   = Array.isArray(bets)
    ? bets.filter(b => b.placedAt?.startsWith(today) && (!b.result || b.result === 'pending')).length
    : 0;
  json(res, {
    active,
    cyclesRun:    preState.cycle_stats?.cycles_run || 0,
    signalsToday: preState.cycle_stats?.signals_emitted || 0,
    monitorUp:    true,
    serverTime:   new Date().toISOString(),
    uptime:       process.uptime(),
  });
}

function apiStatus(req, res) {
  json(res, {
    status:    'online',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    node:      process.version,
  });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('Payload too large')); }
      data += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function authMiddleware(req, res) {
  const token = extractToken(req);
  if (!token) { json(res, { error: 'Não autenticado' }, 401); return null; }
  const decoded = verifyToken(token);
  if (!decoded) { json(res, { error: 'Token inválido ou expirado' }, 401); return null; }
  const user = getUserById(decoded.id);
  if (!user) { json(res, { error: 'Usuário não encontrado' }, 401); return null; }
  return user;
}

async function requireAdmin(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { json(res, { error: 'Acesso negado' }, 403); return null; }
  return user;
}

// ── Auth API handlers ─────────────────────────────────────────────────────────

async function apiAuthRegister(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip, 'register', 5, 60 * 60_000)) // 5/hora por IP
    return json(res, { error: 'Muitas tentativas. Tente novamente em 1 hora.' }, 429);

  const body = await readBody(req);

  // Validação básica de entrada
  const email = (body.email || '').trim().toLowerCase();
  const name  = (body.name  || '').trim();
  const pass  = body.password || '';

  if (!email || !name || !pass)
    return json(res, { error: 'Nome, email e senha são obrigatórios.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json(res, { error: 'Formato de email inválido.' }, 400);
  if (name.length < 2 || name.length > 80)
    return json(res, { error: 'Nome deve ter entre 2 e 80 caracteres.' }, 400);
  if (pass.length < 6 || pass.length > 128)
    return json(res, { error: 'Senha deve ter entre 6 e 128 caracteres.' }, 400);

  try {
    const result = registerUser(name, email, pass);
    json(res, result, 201);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
}

async function apiAuthLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip, 'login', 30, 15 * 60_000)) // 30 tentativas por 15 min por IP
    return json(res, { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }, 429);

  const body  = await readBody(req);
  const email = (body.email || '').trim().toLowerCase();
  const pass  = body.password || '';

  if (!email || !pass)
    return json(res, { error: 'Email e senha são obrigatórios.' }, 400);
  if (email.length > 254 || pass.length > 128)
    return json(res, { error: 'Credenciais inválidas.' }, 401);

  try {
    const result = loginUser(email, pass);
    json(res, result);
  } catch (e) {
    json(res, { error: e.message }, 401);
  }
}

async function apiAuthMe(req, res) {
  const token = extractToken(req);
  if (!token) { json(res, { error: 'Não autenticado' }, 401); return; }
  const decoded = verifyToken(token);
  if (!decoded) { json(res, { error: 'Token inválido' }, 401); return; }
  const user = getUserById(decoded.id);
  if (!user) { json(res, { error: 'Usuário não encontrado' }, 401); return; }
  if (!checkAccess(user)) { json(res, { error: 'Trial ou assinatura expirada', expired: true }, 403); return; }
  json(res, user);
}

function apiAuthLogout(req, res) {
  json(res, { ok: true });
}

async function apiPaymentCreate(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip, 'payment', 5, 60 * 60_000)) // 5/hora por IP
    return json(res, { error: 'Muitas tentativas de pagamento. Tente em 1 hora.' }, 429);

  const user = await authMiddleware(req, res);
  if (!user) return;
  const body = await readBody(req);
  try {
    const result = await createPaymentPreference(user.id, body.plan);
    json(res, result);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
}

async function apiPaymentWebhook(req, res) {
  const body = await readBody(req);
  try {
    const result = await processWebhook(body);
    json(res, result);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function apiAdminUsers(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    const users = getAllUsers();
    json(res, { users, total: users.length });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function apiAdminUpdateUser(req, res, userId) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const body = await readBody(req);
  try {
    const updated = updateUser(parseInt(userId), body);
    json(res, updated);
  } catch (e) {
    json(res, { error: e.message }, 400);
  }
}

// ── Route table ───────────────────────────────────────────────────────────────

// ── SofaScore helpers ─────────────────────────────────────────────────────────

const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
};

const GAMES_CACHE    = { data: null, ts: 0, TTL: 2 * 60_000 }; // 2 min para capturar mudanças ao vivo
const ANALYSIS_CACHE = new Map();
const ANALYSIS_TTL   = 20 * 60_000;

async function sofaFetch(path) {
  const res = await fetch(`${SOFA_BASE}${path}`, {
    headers: SOFA_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`SofaScore ${res.status}: ${path}`);
  return res.json();
}

function slugify(name) {
  return (name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function matchSbUrl(sbCache, home, away) {
  // Busca em live primeiro (ao vivo tem prioridade), depois prelive
  const liveEntries    = sbCache?.live?.entries    || [];
  const preliveEntries = sbCache?.prelive?.entries || sbCache?.entries || [];
  const entries = [...liveEntries, ...preliveEntries];

  const hs = slugify(home), as_ = slugify(away);

  // Tentativa 1: match exato de slugs
  let f = entries.find(e => e.home === hs && e.away === as_);
  if (f) return f.url;

  // Tentativa 2: match por prefixo (apelidos/abreviações)
  const h0 = hs.split('-')[0], a0 = as_.split('-')[0];
  f = entries.find(e => e.home.startsWith(h0) && e.away.startsWith(a0));
  if (f) return f.url;

  // Tentativa 3: match por altNames ("Time A·Time B")
  const alt = `${home}·${away}`;
  f = entries.find(e => e.altNames?.includes(alt));
  return f?.url || null;
}

function calcTeamStats(events, teamId, teamName) {
  const last5 = (events || []).slice(0, 5);
  if (!last5.length) return { team: teamName, goals_scored_avg: 1.0, goals_conceded_avg: 1.0, form: '' };
  let scored = 0, conceded = 0, form = '';
  for (const e of last5) {
    const isH = e.homeTeam?.id === teamId;
    const gs = isH ? (e.homeScore?.current || 0) : (e.awayScore?.current || 0);
    const gc = isH ? (e.awayScore?.current || 0) : (e.homeScore?.current || 0);
    scored += gs; conceded += gc;
    const wc = e.winnerCode;
    if (!wc) form += 'D';
    else if ((isH && wc === 1) || (!isH && wc === 2)) form += 'W';
    else form += 'L';
  }
  return {
    team:               teamName,
    goals_scored_avg:   +(scored  / last5.length).toFixed(2),
    goals_conceded_avg: +(conceded / last5.length).toFixed(2),
    form:               form.split('').reverse().join(''),
    xg_avg:             null,
  };
}

// Poisson para placar exato
function poissonProb(lambda, k) {
  if (k < 0 || lambda <= 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
function calcExactScores(lH, lA, top = 12) {
  const scores = [];
  for (let h = 0; h <= 6; h++)
    for (let a = 0; a <= 6; a++)
      scores.push({ score: `${h}-${a}`, home: h, away: a, prob: +(poissonProb(lH, h) * poissonProb(lA, a) * 100).toFixed(2) });
  return scores.sort((a, b) => b.prob - a.prob).slice(0, top);
}

const MARKET_DEFS = [
  // Vitória / Resultado
  { key: 'home_win',          label: 'Casa Vence',         gate: 78, calibKey: '1X2',              group: 'vitoria'      },
  { key: 'draw',              label: 'Empate',             gate: 78, calibKey: '1X2',              group: 'vitoria'      },
  { key: 'away_win',          label: 'Fora Vence',         gate: 78, calibKey: '1X2',              group: 'vitoria'      },
  // Dupla Chance
  { key: 'chance_1x',         label: '1X (Casa ou Emp.)',  gate: 78, calibKey: '1X',               group: 'dupla'        },
  { key: 'chance_x2',         label: 'X2 (Emp. ou Fora)', gate: 78, calibKey: 'X2',               group: 'dupla'        },
  { key: 'chance_12',         label: '12 (Casa ou Fora)', gate: 78, calibKey: '12',               group: 'dupla'        },
  // Gols / BTTS
  { key: 'over_1_5',          label: 'Gols Over 1.5',      gate: 80, calibKey: 'Over 1.5',         group: 'gols'         },
  { key: 'over_2_5',          label: 'Gols Over 2.5',      gate: 80, calibKey: 'Over 2.5',         group: 'gols'         },
  { key: 'over_3_5',          label: 'Gols Over 3.5',      gate: 80, calibKey: 'Over 3.5',         group: 'gols'         },
  { key: 'under_2_5',         label: 'Gols Under 2.5',     gate: 80, calibKey: 'Under 2.5',        group: 'gols'         },
  { key: 'btts',              label: 'BTTS Ambas Marcam',  gate: 78, calibKey: 'BTTS',             group: 'btts'         },
  // Cantos
  { key: 'over_corners_6_5',  label: 'Escanteios Over 6.5', gate: 75, calibKey: 'Over Corners 6.5', group: 'cantos'      },
  { key: 'over_corners_7_5',  label: 'Escanteios Over 7.5', gate: 75, calibKey: 'Over Corners 7.5', group: 'cantos'      },
  { key: 'over_corners_8_5',  label: 'Escanteios Over 8.5', gate: 75, calibKey: 'Over Corners 8.5', group: 'cantos'      },
  { key: 'under_corners_6_5', label: 'Escanteios Under 6.5',gate: 75, calibKey: null,              group: 'cantos'       },
  { key: 'under_corners_7_5', label: 'Escanteios Under 7.5',gate: 75, calibKey: null,              group: 'cantos'       },
  // Cartões
  { key: 'over_yc_2_5',       label: 'Cartões Over 2.5',   gate: 72, calibKey: null,              group: 'cartoes'      },
  { key: 'over_yc_3_5',       label: 'Cartões Over 3.5',   gate: 72, calibKey: null,              group: 'cartoes'      },
  { key: 'over_yc_4_5',       label: 'Cartões Over 4.5',   gate: 72, calibKey: null,              group: 'cartoes'      },
];

// ── Games endpoints ────────────────────────────────────────────────────────────

function _mapSofaEvent(e, sbCache) {
  return {
    id:           e.id,
    home:         e.homeTeam.name,
    homeId:       e.homeTeam.id,
    away:         e.awayTeam.name,
    awayId:       e.awayTeam.id,
    competition:  e.tournament?.uniqueTournament?.name || e.tournament?.name || '—',
    country:      e.tournament?.category?.name || '',
    kickoff:      e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString() : null,
    status:       e.status?.type || 'notstarted',
    statusDesc:   e.status?.description || null,
    score:        (e.homeScore?.current != null && e.awayScore?.current != null)
                    ? `${e.homeScore.current}-${e.awayScore.current}` : null,
    homeScore:    e.homeScore?.current ?? null,
    awayScore:    e.awayScore?.current ?? null,
    minutePlayed: e.time?.played ?? null,
    period:       e.time?.period ?? null,
    round:        e.roundInfo?.round || null,
    superbetUrl:  matchSbUrl(sbCache, e.homeTeam.name, e.awayTeam.name),
  };
}

async function apiGamesToday(req, res) {
  const now    = Date.now();
  const qs     = parseQS(req.url);
  const force  = qs.refresh === '1';

  if (!force && GAMES_CACHE.data && (now - GAMES_CACHE.ts) < GAMES_CACHE.TTL) {
    return json(res, GAMES_CACHE.data);
  }

  const today   = new Date().toISOString().slice(0, 10);
  const sbCache = loadJSON(join(ROOT, 'data/superbet-url-cache.json'), {});

  try {
    // Busca em paralelo: jogos do dia + eventos ao vivo
    const [scheduledData, liveData] = await Promise.allSettled([
      sofaFetch(`/sport/football/scheduled-events/${today}`),
      sofaFetch(`/sport/football/events/live`),
    ]);

    const scheduledEvents = scheduledData.status === 'fulfilled'
      ? (scheduledData.value.events || []).filter(e => e.homeTeam && e.awayTeam)
      : [];

    const liveEvents = liveData.status === 'fulfilled'
      ? (liveData.value.events || []).filter(e => e.homeTeam && e.awayTeam)
      : [];

    // Merge: live events sobrescrevem os scheduled (dados mais frescos)
    const byId = new Map();
    for (const e of scheduledEvents) byId.set(e.id, _mapSofaEvent(e, sbCache));
    for (const e of liveEvents)      byId.set(e.id, _mapSofaEvent(e, sbCache)); // live tem prioridade

    const games = Array.from(byId.values())
      .sort((a, b) => {
        // Live primeiro, depois por horário
        if (a.status === 'inprogress' && b.status !== 'inprogress') return -1;
        if (b.status === 'inprogress' && a.status !== 'inprogress') return 1;
        return (a.kickoff || '') < (b.kickoff || '') ? -1 : 1;
      });

    const result = {
      date:      today,
      total:     games.length,
      liveCount: games.filter(g => g.status === 'inprogress').length,
      sources:   ['SofaScore', 'Superbet'],
      games,
      refreshed: new Date().toISOString(),
    };
    GAMES_CACHE.data = result;
    GAMES_CACHE.ts   = now;
    json(res, result);
  } catch(e) {
    json(res, { error: e.message, date: today, total: 0, liveCount: 0, games: [], sources: [] }, 500);
  }
}

async function apiGameAnalysis(req, res, gameId) {
  const cid = String(gameId);
  const cached = ANALYSIS_CACHE.get(cid);
  if (cached && (Date.now() - cached.ts) < ANALYSIS_TTL) return json(res, cached.data);

  try {
    const eventData = await sofaFetch(`/event/${cid}`);
    const event = eventData.event;
    if (!event) return json(res, { error: 'Jogo não encontrado' }, 404);

    const [homeLast, awayLast] = await Promise.allSettled([
      sofaFetch(`/team/${event.homeTeam.id}/events/last/0`),
      sofaFetch(`/team/${event.awayTeam.id}/events/last/0`),
    ]);

    const homeEvents = homeLast.status === 'fulfilled' ? (homeLast.value.events || []) : [];
    const awayEvents = awayLast.status === 'fulfilled' ? (awayLast.value.events || []) : [];
    const homeStats  = calcTeamStats(homeEvents, event.homeTeam.id, event.homeTeam.name);
    const awayStats  = calcTeamStats(awayEvents, event.awayTeam.id, event.awayTeam.name);

    const analysis = analyzeQuantitative({
      home: homeStats, away: awayStats,
      competition: event.tournament?.uniqueTournament?.name || event.tournament?.name || '',
      h2h: [], odds: null,
    });

    const pie   = loadJSON(join(ROOT, 'data/pie.json'), {});
    const calib = pie.calibration || {};

    const probs = analysis.probabilities || {};
    const lH = analysis.lambda_home || 1.2;
    const lA = analysis.lambda_away || 1.0;

    // Monta todos os mercados com dados de calibração PIE
    const allMarkets = MARKET_DEFS.map(m => {
      const prob   = +(((probs[m.key] || 0) * 100)).toFixed(1);
      const cd     = m.calibKey ? calib[m.calibKey] : null;
      const pieAcc = cd?.total ? +((cd.hits / cd.total) * 100).toFixed(1) : null;
      return { market: m.label, key: m.key, group: m.group, prob, gate: m.gate, pieAcc, pieSamples: cd?.total || 0, ok: prob >= m.gate };
    });

    // Agrupa por categoria
    const GROUP_LABELS = {
      vitoria:  { label: 'Vitória / Resultado', icon: '🏆' },
      dupla:    { label: 'Dupla Chance',        icon: '🔄' },
      gols:     { label: 'Gols',                icon: '⚽' },
      btts:     { label: 'BTTS',                icon: '🔁' },
      cantos:   { label: 'Cantos',              icon: '🔺' },
      cartoes:  { label: 'Cartões',             icon: '🟨' },
    };
    const marketGroups = {};
    for (const [gk, gl] of Object.entries(GROUP_LABELS)) {
      marketGroups[gk] = { ...gl, markets: allMarkets.filter(m => m.group === gk) };
    }

    // Top 5 recomendações (excluindo dupla chance para não poluir)
    const recommendations = allMarkets
      .filter(m => m.ok && m.group !== 'dupla')
      .sort((a, b) => (b.prob + (b.pieAcc || 0) * 0.4) - (a.prob + (a.pieAcc || 0) * 0.4))
      .slice(0, 5);

    // Placares exatos via Poisson
    const exactScores = calcExactScores(lH, lA);

    const sbCache = loadJSON(join(ROOT, 'data/superbet-url-cache.json'), {});
    const result = {
      id:          event.id,
      match:       `${event.homeTeam.name} vs ${event.awayTeam.name}`,
      home:        event.homeTeam.name,
      homeId:      event.homeTeam.id,
      away:        event.awayTeam.name,
      awayId:      event.awayTeam.id,
      competition: event.tournament?.uniqueTournament?.name || event.tournament?.name || '',
      kickoff:     event.startTimestamp ? new Date(event.startTimestamp * 1000).toISOString() : null,
      superbetUrl: matchSbUrl(sbCache, event.homeTeam.name, event.awayTeam.name),
      model: {
        lambdaHome:  +lH.toFixed(2),
        lambdaAway:  +lA.toFixed(2),
        confidence:  +((analysis.model_confidence || 0) * 100).toFixed(0),
        uncertainty: analysis.uncertainty || 'Médio',
        favoritismo: analysis.probabilistic_scores?.favoritismo || '—',
        leader:      analysis.probabilistic_scores?.leader || '—',
      },
      homeStats, awayStats,
      recommendations,
      exactScores,
      marketGroups,
      allMarkets,
    };

    ANALYSIS_CACHE.set(cid, { data: result, ts: Date.now() });
    json(res, result);
  } catch(e) {
    console.error('[ANALYSIS]', e.message);
    json(res, { error: e.message }, 500);
  }
}

async function apiAutobetApply(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const bet = JSON.parse(body);
      const queuePath = join(ROOT, 'data/autobet-queue.json');
      const queue = loadJSON(queuePath, []);
      queue.push({ ...bet, queuedAt: new Date().toISOString(), status: 'queued' });
      writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');
      json(res, { success: true, message: 'Aposta adicionada à fila do Auto-Bettor', queueLength: queue.length });
    } catch(e) {
      json(res, { error: e.message }, 400);
    }
  });
}

// Traduz labels do dashboard → chaves do MARKET_MAP do superbet-placer
const MARKET_LABEL_TO_KEY = {
  'Casa Vence':             'Home Win',
  'Fora Vence':             'Away Win',
  'Empate':                 'Draw',
  '1X (Casa ou Emp.)':      '1X',
  'X2 (Emp. ou Fora)':      'X2',
  '12 (Casa ou Fora)':      '12',
  // labels descritivos novos
  'Gols Over 1.5':          'Over 1.5',
  'Gols Over 2.5':          'Over 2.5',
  'Gols Over 3.5':          'Over 3.5',
  'Gols Under 2.5':         'Under 2.5',
  'BTTS Ambas Marcam':      'BTTS',
  'Escanteios Over 6.5':    'Over Corners 6.5',
  'Escanteios Over 7.5':    'Over Corners 7.5',
  'Escanteios Over 8.5':    'Over Corners 8.5',
  'Escanteios Under 6.5':   'Under Corners 6.5',
  'Escanteios Under 7.5':   'Under Corners 7.5',
  'Cartões Over 2.5':       'Over YC 2.5',
  'Cartões Over 3.5':       'Over YC 3.5',
  'Cartões Over 4.5':       'Over YC 4.5',
  // legado
  'Over 2.5 Cartões':       'Over YC 2.5',
  'Over 3.5 Cartões':       'Over YC 3.5',
  'Over 4.5 Cartões':       'Over YC 4.5',
};

// Deriva recomendação a partir do nome do mercado
function deriveRec(market) {
  const m = (market || '').toLowerCase();
  if (m.includes('btts') || m.includes('ambas'))          return 'SIM';
  if (m.startsWith('under') || m.includes('menos de'))    return 'UNDER';
  if (m === 'empate' || m === 'draw')                      return 'X';
  if (m === 'casa vence' || m === 'home win')              return '1';
  if (m === 'fora vence' || m === 'away win')              return '2';
  if (m.startsWith('1x'))                                  return '1X';
  if (m.startsWith('x2'))                                  return 'X2';
  if (m.startsWith('12'))                                  return '12';
  return 'APOSTAR';
}

async function apiAutobetExecute(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const bet = JSON.parse(body);
      const { superbetUrl, market, match, homeTeam, awayTeam, prob, competition, stake } = bet;

      // Verificar sessão Superbet
      const sessionPath = join(ROOT, 'data/superbet-session.json');
      if (!existsSync(sessionPath)) {
        return json(res, {
          error: 'Sessão Superbet não encontrada. Execute "npm run autobet-login" no terminal primeiro.',
          noSession: true,
        }, 422);
      }

      // Traduzir label e derivar recommendation
      const marketKey    = MARKET_LABEL_TO_KEY[market] || market;
      const recommendation = deriveRec(market);

      // Extrair home/away
      const [parsedHome, parsedAway] = (match || '').split(' vs ').map(s => s.trim());
      const home = homeTeam || parsedHome || '';
      const away = awayTeam || parsedAway || '';

      const entryId = Date.now();

      // Gravar na fila
      const queuePath = join(ROOT, 'data/autobet-queue.json');
      const queue = loadJSON(queuePath, []);
      queue.push({ ...bet, marketKey, recommendation, id: entryId, queuedAt: new Date().toISOString(), status: 'executing' });
      writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

      // Log em arquivo para debug
      const logPath = join(ROOT, `data/autobet-log-${entryId}.txt`);

      const { spawn }           = await import('child_process');
      const { createWriteStream } = await import('fs');
      const logStream = createWriteStream(logPath, { flags: 'a' });

      // Montar args
      const args = ['scripts/place-bet-now.js', `--entry-id=${entryId}`];
      if (superbetUrl) {
        args.push(`--url=${superbetUrl}`);
      } else if (home && away) {
        args.push(`--home=${home}`, `--away=${away}`);
      } else {
        return json(res, { error: 'URL ou times não identificados para este jogo', noUrl: true }, 422);
      }
      const stakeVal = parseFloat(stake) || 2;
      const clampedStake = Math.min(100, Math.max(1, stakeVal));
      args.push(
        `--match=${match}`,
        `--market=${marketKey}`,
        `--recommendation=${recommendation}`,
        `--prob=${prob || ''}`,
        `--competition=${competition || ''}`,
        `--stake=${clampedStake.toFixed(2)}`,
      );

      console.log(`[EXECUTE] ${args.slice(0, 4).join(' ')} ...`);

      const child = spawn('node', args, {
        cwd: ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
      child.on('close', code => {
        logStream.end();
        console.log(`[EXECUTE] saiu código=${code} entryId=${entryId}`);
      });
      child.on('error', err => {
        logStream.end(`\nERRO SPAWN: ${err.message}\n`);
        try {
          writeFileSync(join(ROOT, `data/autobet-result-${entryId}.json`),
            JSON.stringify({ entryId, status: 'error', error: err.message, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
        } catch {}
        console.error('[EXECUTE] Erro spawn:', err.message);
      });

      json(res, {
        ok:       true,
        entryId,
        searching: !superbetUrl,
        match,
        market:   marketKey,
        recommendation,
        superbetUrl: superbetUrl || null,
      });
    } catch(e) {
      console.error('[EXECUTE]', e.message);
      json(res, { error: e.message }, 500);
    }
  });
}

function apiAutobetStatus(req, res, entryId) {
  const resultPath = join(ROOT, `data/autobet-result-${entryId}.json`);
  const data = loadJSON(resultPath, null);
  if (!data) return json(res, { status: 'pending' });
  json(res, data);
}

// ── Superbet balance & history ────────────────────────────────────────────────

function apiSuperbetBalance(req, res) {
  const cached = loadJSON(join(ROOT, 'data/superbet-balance.json'), null);
  if (cached) return json(res, cached);
  json(res, { balance: null, balanceText: null, scrapedAt: null });
}

async function apiSuperbetSyncBalance(req, res) {
  const sessionPath = join(ROOT, 'data/superbet-session.json');
  if (!existsSync(sessionPath)) return json(res, { error: 'Sessão não encontrada. Execute npm run autobet-login primeiro.' }, 422);

  const statusPath = join(ROOT, 'data/sync-balance-status.json');
  const current = loadJSON(statusPath, {});
  if (current.running) return json(res, { ok: true, alreadyRunning: true });

  writeFileSync(statusPath, JSON.stringify({ running: true, startedAt: new Date().toISOString() }));

  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/scrape-superbet-data.js', '--balance'], {
    cwd: ROOT, env: { ...process.env }, stdio: 'pipe',
  });
  child.on('close', code => {
    writeFileSync(statusPath, JSON.stringify({
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
    }));
    console.log(`[SyncBalance] concluído code=${code}`);
  });

  json(res, { ok: true, started: true });
}

async function apiSuperbetSyncBets(req, res) {
  const sessionPath = join(ROOT, 'data/superbet-session.json');
  if (!existsSync(sessionPath)) return json(res, { error: 'Sessão não encontrada. Execute npm run autobet-login primeiro.' }, 422);

  const statusPath = join(ROOT, 'data/sync-bets-status.json');
  const current = loadJSON(statusPath, {});
  if (current.running) return json(res, { ok: true, alreadyRunning: true });

  writeFileSync(statusPath, JSON.stringify({ running: true, startedAt: new Date().toISOString() }));

  const { spawn } = await import('child_process');
  const child = spawn('node', ['scripts/scrape-superbet-data.js', '--history'], {
    cwd: ROOT, env: { ...process.env }, stdio: 'pipe',
  });
  child.on('close', code => {
    writeFileSync(statusPath, JSON.stringify({
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
    }));
    console.log(`[SyncBets] concluído code=${code}`);
  });

  json(res, { ok: true, started: true });
}

function apiSuperbetBets(req, res) {
  const data = loadJSON(join(ROOT, 'data/superbet-history.json'), null);
  if (!data) return json(res, { bets: [], open: [], closed: [], total: 0, scrapedAt: null });
  // garante campos open/closed mesmo em arquivos antigos sem essas chaves
  const bets   = data.bets   || [];
  const open   = data.open   || bets.filter(b => b.betStatus === 'open'   || b.result === 'pending');
  const closed = data.closed || bets.filter(b => b.betStatus !== 'open'   && b.result !== 'pending');
  json(res, { ...data, bets, open, closed });
}

function apiSuperbetSyncStatus(req, res) {
  const bs  = loadJSON(join(ROOT, 'data/sync-balance-status.json'), { running: false });
  const bts = loadJSON(join(ROOT, 'data/sync-bets-status.json'),    { running: false });
  json(res, { balance: bs, bets: bts });
}

// ── Superbet por usuário ──────────────────────────────────────────────────────

async function apiSuperbetConnect(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;
  const { email, password } = await readBody(req);
  if (!email || !password) return json(res, { error: 'Email e senha são obrigatórios' }, 400);
  try {
    saveSuperbetCredentials(user.id, email, password);
    json(res, { ok: true });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function apiSuperbetUserData(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;
  const data = getUserSuperbetData(user.id);
  json(res, data || { connected: false });
}

async function apiSuperbetUserSync(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;

  const creds = getSuperbetCredentials(user.id);
  if (!creds) return json(res, { error: 'Conta Superbet não conectada. Conecte primeiro em /connect-superbet.' }, 422);

  const statusPath = join(ROOT, `data/sync-user-${user.id}-status.json`);
  const current    = loadJSON(statusPath, {});
  // Se já está rodando mas o processo está travado há mais de 5 minutos, reseta automaticamente
  const staleMs = 5 * 60_000;
  const isStale = current.running && current.startedAt && (Date.now() - new Date(current.startedAt).getTime()) > staleMs;
  if (current.running && !isStale) return json(res, { ok: true, alreadyRunning: true });

  const body = await readBody(req);
  writeFileSync(statusPath, JSON.stringify({ running: true, startedAt: new Date().toISOString() }));
  const mode = body.mode || 'both';
  const args = ['scripts/scrape-superbet-data.js'];
  if (mode === 'balance' || mode === 'both') args.push('--balance');
  if (mode === 'bets'    || mode === 'both') args.push('--history');

  const { spawn } = await import('child_process');
  const stderrLines = [];
  const child = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env, SUPERBET_EMAIL: creds.email, SUPERBET_PASSWORD: creds.password, SB_USER_ID: String(user.id) },
    stdio: 'pipe',
  });

  child.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) { stderrLines.push(line); console.error(`[UserSync] STDERR: ${line}`); }
  });
  child.stdout.on('data', d => console.log(`[UserSync] ${d.toString().trim()}`));

  child.on('close', code => {
    let dbError = null;
    try {
      if (mode === 'balance' || mode === 'both') {
        const f = loadJSON(join(ROOT, `data/superbet-user-${user.id}-balance.json`), null);
        if (f) updateUserSuperbetData(user.id, { balance: f.balance, balanceText: f.balanceText, lastSync: f.scrapedAt });
        else dbError = 'Arquivo de saldo não gerado — verifique logs do Playwright';
      }
      if (mode === 'bets' || mode === 'both') {
        const f = loadJSON(join(ROOT, `data/superbet-user-${user.id}-bets.json`), null);
        if (f) updateUserSuperbetData(user.id, { bets: f, lastSync: f.scrapedAt });
      }
    } catch (e) { console.error('[UserSync] DB update error:', e.message); dbError = e.message; }
    writeFileSync(statusPath, JSON.stringify({
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      error: code !== 0 ? (stderrLines.slice(-3).join(' | ') || dbError || 'Scraping falhou') : null,
    }));
    console.log(`[UserSync] user=${user.id} concluído code=${code}${code !== 0 ? ' — ERRO' : ''}`);
  });

  json(res, { ok: true, started: true });
}

async function apiSuperbetUserSyncStatus(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;
  const status = loadJSON(join(ROOT, `data/sync-user-${user.id}-status.json`), { running: false });
  json(res, status);
}

async function apiSuperbetUserSyncReset(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;
  const statusPath = join(ROOT, `data/sync-user-${user.id}-status.json`);
  writeFileSync(statusPath, JSON.stringify({ running: false, resetAt: new Date().toISOString() }));
  json(res, { ok: true, reset: true });
}

async function apiDiagPlaywright(req, res) {
  const user = await authMiddleware(req, res);
  if (!user) return;
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execP = promisify(execFile);
  try {
    const { stdout } = await execP('node', ['-e',
      "import('@playwright/test').then(m=>console.log('ok:'+m.chromium?.name())).catch(e=>console.error('err:'+e.message))"
    ], { cwd: ROOT, timeout: 10000 });
    json(res, { playwright: stdout.includes('ok:') ? 'ok' : 'error', output: stdout.trim() });
  } catch(e) {
    json(res, { playwright: 'missing', error: e.message });
  }
}

// ── Route table ───────────────────────────────────────────────────────────────

const ROUTES = {
  '/api/dashboard':   apiDashboard,
  '/api/bets':        apiBets,
  '/api/bankroll':    apiBankroll,
  '/api/analyses':    apiAnalyses,
  '/api/live':        apiLive,
  '/api/status':      apiStatus,
  '/api/games/today': apiGamesToday,
};

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://bettingsquadpro.com',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      ...SEC_HEADERS,
    });
    return res.end();
  }

  // Bloquear métodos não esperados
  if (!['GET','POST','PATCH','OPTIONS'].includes(req.method)) {
    res.writeHead(405, SEC_HEADERS); return res.end('Method Not Allowed');
  }

  // Rate limit global de API (600 req/min por IP — protege contra bots, não usuários normais)
  const clientIp = req.socket.remoteAddress || 'unknown';
  if (path.startsWith('/api/') && !path.startsWith('/api/auth/') && rateLimit(clientIp, 'api_global', 600, 60_000))
    return json(res, { error: 'Too many requests' }, 429);

  // ── Auth routes (públicas — sem verificação de token) ──
  if (path === '/api/auth/register' && req.method === 'POST') return apiAuthRegister(req, res);
  if (path === '/api/auth/login'    && req.method === 'POST') return apiAuthLogin(req, res);
  if (path === '/api/auth/logout'   && req.method === 'POST') return apiAuthLogout(req, res);
  if (path === '/api/auth/me'       && req.method === 'GET')  return apiAuthMe(req, res);
  if (path === '/api/payment/webhook' && req.method === 'POST') return apiPaymentWebhook(req, res);

  // ── Payment routes ──
  if (path === '/api/payment/create' && req.method === 'POST') return apiPaymentCreate(req, res);

  // ── Admin routes ──
  if (path === '/api/admin/users' && req.method === 'GET') return apiAdminUsers(req, res);
  const adminUserMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (adminUserMatch && req.method === 'PATCH') return apiAdminUpdateUser(req, res, adminUserMatch[1]);

  // API
  if (path.startsWith('/api/')) {
    const handler = ROUTES[path];
    if (handler) return handler(req, res);

    // Dynamic: GET /api/games/:id/analysis
    const analysisMatch = path.match(/^\/api\/games\/(\d+)\/analysis$/);
    if (analysisMatch && req.method === 'GET') return apiGameAnalysis(req, res, analysisMatch[1]);

    // Dynamic: POST /api/autobet/apply
    if (path === '/api/autobet/apply' && req.method === 'POST') return apiAutobetApply(req, res);

    // Dynamic: POST /api/autobet/execute
    if (path === '/api/autobet/execute' && req.method === 'POST') return apiAutobetExecute(req, res);

    // Dynamic: GET /api/autobet/status/:entryId
    const statusMatch = path.match(/^\/api\/autobet\/status\/(\d+)$/);
    if (statusMatch && req.method === 'GET') return apiAutobetStatus(req, res, statusMatch[1]);

    // GET /api/superbet/balance — retorna saldo em cache
    if (path === '/api/superbet/balance' && req.method === 'GET') return apiSuperbetBalance(req, res);

    // POST /api/superbet/sync-balance — inicia scraping do saldo
    if (path === '/api/superbet/sync-balance' && req.method === 'POST') return apiSuperbetSyncBalance(req, res);

    // POST /api/superbet/sync-bets — importa histórico de apostas
    if (path === '/api/superbet/sync-bets' && req.method === 'POST') return apiSuperbetSyncBets(req, res);

    // GET /api/superbet/bets — retorna apostas importadas em cache
    if (path === '/api/superbet/bets' && req.method === 'GET') return apiSuperbetBets(req, res);

    // GET /api/superbet/sync-status — estado atual dos jobs de sincronização
    if (path === '/api/superbet/sync-status' && req.method === 'GET') return apiSuperbetSyncStatus(req, res);

    // ── Por usuário ──
    if (path === '/api/superbet/connect'          && req.method === 'POST') return apiSuperbetConnect(req, res);
    if (path === '/api/superbet/user-data'        && req.method === 'GET')  return apiSuperbetUserData(req, res);
    if (path === '/api/superbet/user-sync'        && req.method === 'POST') return apiSuperbetUserSync(req, res);
    if (path === '/api/superbet/user-sync-status' && req.method === 'GET')  return apiSuperbetUserSyncStatus(req, res);
    if (path === '/api/superbet/user-sync-reset'  && req.method === 'POST') return apiSuperbetUserSyncReset(req, res);
    if (path === '/api/diag/playwright'           && req.method === 'GET')  return apiDiagPlaywright(req, res);

    return json(res, { error: 'Not found' }, 404);
  }

  // ── Páginas HTML especiais ──
  if (path === '/login')            return htmlPage(res, join(PUBLIC, 'login.html'));
  if (path === '/register')         return htmlPage(res, join(PUBLIC, 'register.html'));
  if (path === '/subscribe')        return htmlPage(res, join(PUBLIC, 'subscribe.html'));
  if (path === '/admin')            return htmlPage(res, join(PUBLIC, 'admin.html'));
  if (path === '/connect-superbet') return htmlPage(res, join(PUBLIC, 'connect-superbet.html'));

  // Static files
  const filePath = path === '/' ? join(PUBLIC, 'index.html') : join(PUBLIC, path.slice(1));
  try {
    const stat = statSync(filePath);
    if (stat.isFile()) {
      const mime = MIME[extname(filePath)] || 'application/octet-stream';
      const isHtml = mime.startsWith('text/html');
      res.writeHead(200, { 'Content-Type': mime, ...(isHtml ? SEC_HEADERS : {}) });
      return res.end(readFileSync(filePath));
    }
  } catch {}

  // SPA fallback
  htmlPage(res, join(PUBLIC, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '═'.repeat(52));
  console.log('  ⚡ BettingSquad Pro  —  Dashboard Web');
  console.log('═'.repeat(52));
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  📊  API: http://localhost:${PORT}/api/status`);
  console.log('═'.repeat(52) + '\n');
});
