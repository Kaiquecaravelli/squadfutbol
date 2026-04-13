import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../data/bets.json');

mkdirSync(dirname(DB_PATH), { recursive: true });

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { analyses: [], bets: [] });

async function load() {
  await db.read();
  db.data.analyses ??= [];
  db.data.bets     ??= [];
}

// ── Salvar análise ────────────────────────────────────────────────────────────
export async function saveAnalysis(data) {
  await load();
  const id = Date.now();
  db.data.analyses.push({ id, ...data, created_at: new Date().toISOString() });
  await db.write();
  return id;
}

// ── Registrar aposta realizada ────────────────────────────────────────────────
export async function logBet({ analysisId, matchName, market, odds, house, stake, bankroll }) {
  await load();
  const id = Date.now();
  db.data.bets.push({
    id,
    analysis_id: analysisId,
    match_name: matchName,
    market,
    odds,
    house,
    stake,
    bankroll_at_time: bankroll,
    result: 'pending',
    profit_loss: null,
    created_at: new Date().toISOString(),
  });
  await db.write();
  return id;
}

// ── Atualizar resultado de uma aposta ─────────────────────────────────────────
export async function updateBetResult(betId, result, profitLoss) {
  await load();
  const bet = db.data.bets.find((b) => b.id === betId);
  if (bet) {
    bet.result = result;
    bet.profit_loss = profitLoss;
    await db.write();
  }
}

// ── Estatísticas de ROI ───────────────────────────────────────────────────────
export async function getRoiStats() {
  await load();
  const closed = db.data.bets.filter((b) => b.result !== 'pending');
  if (!closed.length) return { total_bets: 0, wins: 0, losses: 0, total_profit: 0, total_staked: 0, roi_pct: 0 };

  const wins   = closed.filter((b) => b.result === 'win').length;
  const losses = closed.filter((b) => b.result === 'loss').length;
  const total_profit = closed.reduce((s, b) => s + (b.profit_loss || 0), 0);
  const total_staked = closed.reduce((s, b) => s + (b.stake || 0), 0);

  return {
    total_bets: closed.length,
    wins,
    losses,
    total_profit: Math.round(total_profit * 100) / 100,
    total_staked: Math.round(total_staked * 100) / 100,
    roi_pct: total_staked > 0 ? Math.round((total_profit / total_staked) * 10000) / 100 : 0,
  };
}

// ── Histórico de análises ─────────────────────────────────────────────────────
export async function getRecentAnalyses(limit = 10) {
  await load();
  return [...db.data.analyses]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}
