/**
 * PIE Dashboard — Avaliação de Performance dos Analistas em Tempo Real
 *
 * Métricas por agente (mercado):
 *  - Acurácia geral e por período (7d / 30d)
 *  - Tendência: compara últimas 10 predições vs histórico total
 *  - Sequência atual: quantos acertos/erros consecutivos
 *  - Nota de calibração: quão bem a probabilidade declarada reflete a realidade
 *  - Lições aprendidas: proxy de auto-correção do modelo
 *  - Ranking ponderado: acurácia + tendência + calibração
 */

import { loadDB } from './pie-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Agentes conhecidos — mantém ordem de exibição fixa
// ─────────────────────────────────────────────────────────────────────────────
const AGENTS = [
  { market: 'Ambas Marcam', icon: '⚽', alias: ['BTTS', 'Ambas Marcam', 'Ambas marcam'] },
  { market: 'Gols',         icon: '🥅', alias: ['Over 0.5','Over 1.5','Over 2.5','Over 3.5','Under 2.5','Under 1.5','Gols'] },
  { market: 'Escanteios',   icon: '⛳', alias: ['Escanteios', 'Corners'] },
  { market: 'Cartões',      icon: '🟨', alias: ['Cartões', 'Cartoes', 'Amarelos'] },
  { market: 'Dupla Chance', icon: '🔄', alias: ['Dupla Chance', '1X', 'X2', '12'] },
  { market: 'Placar Exato', icon: '🎯', alias: ['Placar Exato'] },
];

// Resolve nome de mercado para grupo canônico
function resolveAgent(market) {
  const mu = (market || '').toUpperCase();
  for (const a of AGENTS) {
    for (const alias of a.alias) {
      if (mu.includes(alias.toUpperCase())) return a;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nota de calibração baseada no desvio entre probabilidade declarada e acurácia real
// ─────────────────────────────────────────────────────────────────────────────
function calcCalibrationGrade(accuracy, samples) {
  if (samples < 3) return { grade: 'N/A', icon: '⚪', desc: 'Amostras insuficientes' };
  const acc = Number(accuracy) || 0;
  // Esperado: prob declarada ≥ 80% → acurácia real deveria ser ~80%
  if (acc >= 82) return { grade: 'A+', icon: '🟢', desc: 'Excelente calibração' };
  if (acc >= 75) return { grade: 'A',  icon: '🟢', desc: 'Boa calibração' };
  if (acc >= 65) return { grade: 'B',  icon: '🟡', desc: 'Calibração aceitável' };
  if (acc >= 55) return { grade: 'C',  icon: '🟠', desc: 'Superestimando probabilidades' };
  return           { grade: 'D',  icon: '🔴', desc: 'Calibração crítica — revisar modelo' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tendência: compara últimas 10 predições vs média histórica
// ─────────────────────────────────────────────────────────────────────────────
function calcTrend(recentOutcomes, overallAccuracy) {
  const verificaveis = recentOutcomes.filter((o) => o.acertou !== null);
  if (verificaveis.length < 3) return { arrow: '→', delta: 0, label: 'Estável' };

  const recentAcc = (verificaveis.filter((o) => o.acertou).length / verificaveis.length) * 100;
  const delta     = Math.round(recentAcc - (Number(overallAccuracy) || 0));

  if (delta >= 8)  return { arrow: '↗↗', delta, label: `+${delta}%`, strong: true };
  if (delta >= 3)  return { arrow: '↗',  delta, label: `+${delta}%` };
  if (delta <= -8) return { arrow: '↘↘', delta, label: `${delta}%`,  strong: true };
  if (delta <= -3) return { arrow: '↘',  delta, label: `${delta}%` };
  return                  { arrow: '→',  delta: 0, label: 'Estável' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequência atual: últimos resultados consecutivos iguais
// ─────────────────────────────────────────────────────────────────────────────
function calcStreak(outcomes) {
  // Filtra apenas resultados verificáveis (ignora null mid-sequence)
  const verificaveis = outcomes.filter((o) => o.acertou !== null);
  if (!verificaveis.length) return { count: 0, type: null };

  const last = verificaveis[verificaveis.length - 1].acertou;
  let count = 0;
  for (let i = verificaveis.length - 1; i >= 0; i--) {
    if (verificaveis[i].acertou === last) count++;
    else break;
  }
  return { count, type: last ? 'win' : 'loss' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score de ranking ponderado (0–100)
// ─────────────────────────────────────────────────────────────────────────────
function calcRankScore(acc, trend, grade, samples) {
  if (samples < 3) return 0;
  const accScore   = Number(acc) || 0;                    // 0–100
  const trendBonus = Math.max(-10, Math.min(10, trend.delta)); // ±10
  const gradeBonus = { 'A+': 5, A: 3, B: 0, C: -3, D: -8, 'N/A': 0 }[grade.grade] || 0;
  return Math.max(0, Math.min(100, accScore + trendBonus + gradeBonus));
}

// ─────────────────────────────────────────────────────────────────────────────
// Constrói relatório completo de um agente
// ─────────────────────────────────────────────────────────────────────────────
function buildAgentReport(agentDef, db) {
  const { market, icon } = agentDef;

  // Coletar todos os outcomes deste agente de todos os resultados
  const allOutcomes = [];
  for (const result of db.results) {
    for (const o of result.market_outcomes) {
      if (resolveAgent(o.market)?.market === market) {
        allOutcomes.push({ ...o, registered_at: result.registered_at });
      }
    }
  }

  // Ordenar por data de registro
  allOutcomes.sort((a, b) => new Date(a.registered_at) - new Date(b.registered_at));

  const verificaveis = allOutcomes.filter((o) => o.acertou !== null);
  const acertos      = verificaveis.filter((o) => o.acertou === true).length;
  const erros        = verificaveis.filter((o) => o.acertou === false).length;
  const total        = verificaveis.length;
  const accuracy     = total > 0 ? ((acertos / total) * 100).toFixed(1) : null;

  // Calibração do banco de dados
  const calib = db.calibration?.[market] || null;
  // Busca calibração por aliases também
  let calibData = calib;
  if (!calibData) {
    for (const alias of agentDef.alias) {
      if (db.calibration?.[alias]) { calibData = db.calibration[alias]; break; }
    }
  }

  // Tendência: últimas 10 predições verificáveis
  const recentOutcomes = verificaveis.slice(-10);
  const trend  = calcTrend(recentOutcomes, accuracy);
  const streak = calcStreak(verificaveis);
  const grade  = calcCalibrationGrade(accuracy, total);
  const rank   = calcRankScore(accuracy, trend, grade, total);

  // Lições ativas para este agente
  const licoes = db.lessons.filter((l) => l.active && resolveAgent(l.market)?.market === market);

  // Período 7 dias
  const cutoff7d   = Date.now() - 7 * 86_400_000;
  const last7d     = verificaveis.filter((o) => new Date(o.registered_at).getTime() >= cutoff7d);
  const acc7d      = last7d.length
    ? ((last7d.filter((o) => o.acertou).length / last7d.length) * 100).toFixed(1)
    : null;

  return {
    market, icon,
    total, acertos, erros,
    accuracy,
    acc7d,
    trend, streak, grade, rank,
    licoes: licoes.length,
    hasData: total >= 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Função principal — gera dashboard completo
// ─────────────────────────────────────────────────────────────────────────────
export function buildPerformanceDashboard() {
  const db = loadDB();

  const reports = AGENTS.map((a) => buildAgentReport(a, db));

  // Separa agentes com e sem dados
  const comDados  = reports.filter((r) => r.hasData).sort((a, b) => b.rank - a.rank);
  const semDados  = reports.filter((r) => !r.hasData);

  // Totais globais
  const globalTotal   = reports.reduce((s, r) => s + r.total, 0);
  const globalAcertos = reports.reduce((s, r) => s + r.acertos, 0);
  const globalAcc     = globalTotal > 0
    ? ((globalAcertos / globalTotal) * 100).toFixed(1)
    : null;

  // Destaque: melhor sequência
  const bestStreak = comDados
    .filter((r) => r.streak.type === 'win' && r.streak.count >= 2)
    .sort((a, b) => b.streak.count - a.streak.count)[0] || null;

  // Alerta: sequência negativa
  const alertStreak = comDados
    .filter((r) => r.streak.type === 'loss' && r.streak.count >= 2)
    .sort((a, b) => b.streak.count - a.streak.count)[0] || null;

  // Melhor tendência positiva
  const bestTrend = comDados
    .filter((r) => r.trend.delta >= 3)
    .sort((a, b) => b.trend.delta - a.trend.delta)[0] || null;

  return {
    ranking: comDados,
    semDados,
    globalTotal,
    globalAcertos,
    globalAcc,
    bestStreak,
    alertStreak,
    bestTrend,
    updatedAt: new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mini-update de performance após auto-resultado (para mensagem inline)
// ─────────────────────────────────────────────────────────────────────────────
export function buildAgentMiniUpdate(market) {
  const db        = loadDB();
  const canonical = resolveAgent(market);
  if (!canonical) return null;
  const agent = AGENTS.find((a) => a.market === canonical.market);
  if (!agent) return null;
  return buildAgentReport(agent, db);
}
