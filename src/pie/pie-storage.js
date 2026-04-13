/**
 * PIE Storage — Protocolo de Inteligência Evolutiva
 * Camada de persistência: predições, resultados, lições, calibração e logs de agentes.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dir   = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, '../../data/pie.json');

// ── DB Schema ─────────────────────────────────────────────────────────────────
const EMPTY_DB = () => ({
  predictions:       [],
  results:           [],
  lessons:           [],
  positivePatterns:  [],  // reforços de padrões bem-sucedidos
  agentLogs:         [],  // todos os outputs dos agentes (aprovados e não-aprovados)
  calibration:       {},  // { [market]: { total, hits, byRange, byCompetition } }
  model_improvements: [], // log de melhorias aplicadas no modelo (APEX changelog)
  stats: { total: 0, acertos: 0, erros: 0, nao_verificaveis: 0 },
});

export function loadDB() {
  if (!existsSync(DB_PATH)) {
    const db = EMPTY_DB();
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
    return db;
  }
  const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  // Migração: garante campos novos em DBs antigos
  if (!db.calibration)        db.calibration        = {};
  if (!db.agentLogs)          db.agentLogs          = [];
  if (!db.positivePatterns)   db.positivePatterns   = [];
  if (!db.model_improvements) db.model_improvements = [];
  return db;
}

function saveDB(db) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

function _probRange(prob) {
  if (prob >= 95) return '95+';
  if (prob >= 90) return '90-95';
  if (prob >= 85) return '85-90';
  if (prob >= 80) return '80-85';
  if (prob >= 70) return '70-80';
  if (prob >= 60) return '60-70';
  return '<60';
}

// ── Salvar predição ao enviar análise ────────────────────────────────────────
export function savePrediction({ idx, matchData, markets, sofascoreId, kickoffTime }) {
  const db = loadDB();
  const id = randomUUID();

  // Tenta extrair sofascore_id de várias propriedades do matchData
  const sfId = sofascoreId
    || matchData.sofascore_id
    || matchData.match_id
    || null;

  // Só armazena como sofascore_id se for um número inteiro (IDs da SofaScore são numéricos)
  const sofascoreIdFinal = sfId && /^\d+$/.test(String(sfId)) ? Number(sfId) : null;

  db.predictions.push({
    id,
    idx,
    match_id:      `${(matchData.match || '').replace(/\s+/g, '_')}_${matchData.date || ''}`,
    sofascore_id:  sofascoreIdFinal,
    kickoff_time:  kickoffTime || matchData.kickoff_time || null,
    match_name:    matchData.match  || '',
    competition:   matchData.competition || '',
    match_date:    matchData.date   || '',
    // xG do modelo (lambda Poisson) — exibido no Telegram pré-live
    xg_home:       matchData.xg_home ?? null,
    xg_away:       matchData.xg_away ?? null,
    markets: markets.map((m) => ({
      market:         m.market,
      recommendation: m.recommendation,
      probabilidade:  m.probabilidade,
      confianca:      m.confianca || 0,
      odds_minima:    m.odds_minima || null,
      ev_estimado:    m.odds_minima
        ? Number(((m.probabilidade / 100) * m.odds_minima - 1) * 100).toFixed(1)
        : null,
    })),
    created_at: new Date().toISOString(),
    result_id:  null,
  });

  db.stats.total++;
  saveDB(db);
  return id;
}

// ── Salvar log completo de todos os agentes (para treino) ─────────────────────
export function saveAgentLog({ predictionId, matchName, competition, matchDate, agentOutputs }) {
  const db = loadDB();
  db.agentLogs.push({
    id:            randomUUID(),
    prediction_id: predictionId,
    match_name:    matchName,
    competition:   competition || '',
    match_date:    matchDate   || '',
    outputs:       agentOutputs, // array de { market, recommendation, probabilidade, confianca, approved }
    logged_at:     new Date().toISOString(),
  });
  // Limitar log a 500 entradas para não crescer indefinidamente
  if (db.agentLogs.length > 500) db.agentLogs = db.agentLogs.slice(-500);
  saveDB(db);
}

// ── Salvar resultado real e atualizar calibração ──────────────────────────────
export function saveResult({ predictionId, matchName, placarReal, marketOutcomes, competition = '' }) {
  const db = loadDB();
  const id = randomUUID();

  db.results.push({
    id,
    prediction_id:   predictionId,
    match_name:      matchName,
    placar_real:     placarReal,
    competition:     competition || '',
    market_outcomes: marketOutcomes,
    registered_at:   new Date().toISOString(),
  });

  const pred = db.predictions.find((p) => p.id === predictionId);
  if (pred) pred.result_id = id;

  // competition: usa o passado diretamente ou fallback para o da predição vinculada
  const comp = competition || pred?.competition || '';

  // Atualizar calibração e stats globais
  for (const o of marketOutcomes) {
    if (o.acertou === true)       db.stats.acertos++;
    else if (o.acertou === false) db.stats.erros++;
    else                          db.stats.nao_verificaveis = (db.stats.nao_verificaveis || 0) + 1;

    if (o.acertou !== null) {
      _updateCalibration(db, o.market, o.probabilidade, o.acertou, comp);
    }
  }

  saveDB(db);
  return id;
}

/** Normaliza nomes de mercado para evitar fragmentação no PIE.
 *  "BTTS Sim" → "BTTS", "Over 3.5 Gols" → "Over 3.5", etc. */
export function normalizeMarketKey(m) {
  if (!m) return m;
  const s = m.toLowerCase().trim();
  // BTTS / Ambas Marcam
  if (s === 'btts sim' || s === 'btts não' || s === 'btts nao' ||
      s.includes('ambas marcam') || s === 'btts') return 'BTTS';
  // Over/Under com sufixo "Gols"
  const goalsM = s.match(/^(over|under)\s+([\d.]+)\s+gols?$/i);
  if (goalsM) return `${goalsM[1].charAt(0).toUpperCase() + goalsM[1].slice(1)} ${goalsM[2]}`;
  // Over Corners com sufixo
  const cornersM = s.match(/^over\s+(corners?\s+)?([\d.]+)/i);
  if (cornersM && s.includes('corner')) return `Over Corners ${cornersM[2]}`;
  // Resultado Final → unifica
  if (s.startsWith('resultado final')) return 'Resultado Final';
  // Placar Exato / Correct Score
  if (s.includes('correct score') || s.includes('placar exato') || s.match(/^\d+-\d+$/)) return 'Correct Score';
  // Dupla Chance
  if (s === '1x' || s === 'dupla chance casa' || s === 'dupla chance 1x') return '1X';
  if (s === 'x2' || s === 'dupla chance fora' || s === 'dupla chance x2') return 'X2';
  if (s === '12' || s === 'dupla chance semempate' || s === 'vitória de qualquer equipe') return '12';
  // Vitória direta
  if (s === 'home win' || s === 'vitória casa' || s === '1') return 'Home Win';
  if (s === 'away win' || s === 'vitória fora' || s === '2') return 'Away Win';
  if (s === 'draw' || s === 'empate' || s === 'x') return 'Draw';
  return m;
}

function _updateCalibration(db, market, prob, acertou, competition) {
  const key = normalizeMarketKey(market);
  if (!db.calibration[key]) {
    db.calibration[key] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c    = db.calibration[key];
  const fxP  = Number(prob) || 0;
  const hit  = acertou === true ? 1 : 0;
  const range = _probRange(fxP);

  c.total++;
  c.hits += hit;

  if (!c.byRange[range]) c.byRange[range] = { total: 0, hits: 0 };
  c.byRange[range].total++;
  c.byRange[range].hits += hit;

  if (competition) {
    const comp = competition.slice(0, 40);
    if (!c.byCompetition[comp]) c.byCompetition[comp] = { total: 0, hits: 0 };
    c.byCompetition[comp].total++;
    c.byCompetition[comp].hits += hit;
  }
}

// ── Fator de calibração — viés do agente neste mercado/faixa ─────────────────
export function getCalibrationFactor(market, prob) {
  const db    = loadDB();
  const calib = db.calibration[normalizeMarketKey(market)] || db.calibration[market];
  if (!calib || calib.total < 5) return null; // sem dados suficientes

  const range = _probRange(Number(prob) || 0);
  const byR   = calib.byRange[range];
  if (!byR || byR.total < 3) {
    // Usa taxa global
    return { accuracy: (calib.hits / calib.total * 100).toFixed(1), samples: calib.total, range: 'geral' };
  }
  return { accuracy: (byR.hits / byR.total * 100).toFixed(1), samples: byR.total, range };
}

// ── Estatísticas completas de calibração para um agente ──────────────────────
export function getAgentCalibration(market) {
  const db    = loadDB();
  const calib = db.calibration[normalizeMarketKey(market)] || db.calibration[market];
  if (!calib || calib.total === 0) return null;

  const overall = (calib.hits / calib.total * 100).toFixed(1);
  const ranges  = Object.entries(calib.byRange)
    .filter(([, v]) => v.total >= 2)
    .map(([r, v]) => ({ range: r, accuracy: (v.hits / v.total * 100).toFixed(1), samples: v.total }));

  const competitions = Object.entries(calib.byCompetition || {})
    .filter(([, v]) => v.total >= 3)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3)
    .map(([comp, v]) => ({ comp, accuracy: (v.hits / v.total * 100).toFixed(1), samples: v.total }));

  return { market, overall, samples: calib.total, ranges, competitions };
}

// ── Salvar lição aprendida ────────────────────────────────────────────────────
export function saveLesson({ market, competition, directive, errorType, predictionId }) {
  const db = loadDB();

  // Evitar lições idênticas — incrementa contador
  const dup = db.lessons.find((l) => l.market === market && l.directive === directive);
  if (dup) { dup.applied_count++; dup.last_seen = new Date().toISOString(); saveDB(db); return dup.id; }

  const id = randomUUID();
  db.lessons.push({
    id,
    market,
    competition,
    directive,
    error_type:           errorType,
    source_prediction_id: predictionId,
    created_at:           new Date().toISOString(),
    last_seen:            new Date().toISOString(),
    applied_count:        0,
    active:               true,
    weight:               errorType === 'model_failure' ? 2 : 1, // falhas do modelo têm peso maior
  });

  saveDB(db);
  return id;
}

// ── Lições positivas — padrões que funcionaram repetidamente ─────────────────
export function savePositiveLesson({ market, competition, directive, predictionId }) {
  const db = loadDB();

  // Evita duplicatas — incrementa contador de confirmações
  const dup = db.positivePatterns.find((p) => p.market === market && p.directive === directive);
  if (dup) {
    dup.confirmed_count++;
    dup.last_seen = new Date().toISOString();
    saveDB(db);
    return dup.id;
  }

  const id = randomUUID();
  db.positivePatterns.push({
    id,
    market,
    competition,
    directive,
    source_prediction_id: predictionId,
    created_at:     new Date().toISOString(),
    last_seen:      new Date().toISOString(),
    confirmed_count: 0,
    active:         true,
  });

  // Manter os 50 melhores padrões — ordenados por confirmações + recência
  if (db.positivePatterns.length > 50) {
    db.positivePatterns = db.positivePatterns
      .sort((a, b) => {
        const diff = (b.confirmed_count || 0) - (a.confirmed_count || 0);
        if (diff !== 0) return diff;
        return new Date(b.last_seen || b.created_at) - new Date(a.last_seen || a.created_at);
      })
      .slice(0, 50);
  }
  saveDB(db);
  return id;
}

// ── Padrões positivos ativos (para injetar no contexto do agente) ─────────────
export function getPositivePatterns(market) {
  const db = loadDB();
  return db.positivePatterns
    .filter((p) => p.active && (!p.market || p.market === market))
    .sort((a, b) => (b.confirmed_count || 0) - (a.confirmed_count || 0))
    .slice(0, 2);
}

// ── Buscar lições ativas — priorizadas por peso e recência ────────────────────
export function getActiveLessons(market, competition) {
  const db = loadDB();
  return db.lessons
    .filter((l) =>
      l.active &&
      (
        // Lição específica do mesmo mercado
        l.market === market ||
        // Lição cross-market (sem mercado definido — aplica a todos)
        !l.market
      ) &&
      (!l.competition || !competition || l.competition === competition)
    )
    .sort((a, b) => {
      // Ordena: peso decrescente, depois por frequência, depois por data
      const wDiff = (b.weight || 1) - (a.weight || 1);
      if (wDiff !== 0) return wDiff;
      const cDiff = (b.applied_count || 0) - (a.applied_count || 0);
      if (cDiff !== 0) return cDiff;
      return new Date(b.last_seen || b.created_at) - new Date(a.last_seen || a.created_at);
    })
    .slice(0, 4);
}

// ── Buscar predição mais recente sem resultado para um idx ────────────────────
export function getPredictionByIdx(idx) {
  const db = loadDB();
  return db.predictions
    .filter((p) => p.idx === idx && !p.result_id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
}

// ── Buscar predição por ID exato ──────────────────────────────────────────────
export function getPredictionById(id) {
  const db = loadDB();
  return db.predictions.find((p) => p.id === id) || null;
}

// ── Buscar todas as predições pendentes (sem resultado) ───────────────────────
// Usado pelo backfill para tentar buscar resultados retroativamente
export function getPendingPredictions() {
  const db = loadDB();
  return db.predictions.filter((p) => !p.result_id);
}

// ── Estatísticas gerais ───────────────────────────────────────────────────────
export function getStats() {
  const db  = loadDB();
  const { total, acertos, erros, nao_verificaveis } = db.stats;
  const verificaveis = acertos + erros;
  const taxaAcerto   = verificaveis > 0 ? ((acertos / verificaveis) * 100).toFixed(1) : null;
  const licoesAtivas = db.lessons.filter((l) => l.active).length;
  const licoesTotal  = db.lessons.length;

  const porMercado = {};
  for (const r of db.results) {
    for (const o of r.market_outcomes) {
      if (!porMercado[o.market]) porMercado[o.market] = { acertos: 0, erros: 0 };
      if (o.acertou === true)       porMercado[o.market].acertos++;
      else if (o.acertou === false) porMercado[o.market].erros++;
    }
  }

  return { total, acertos, erros, nao_verificaveis, verificaveis, taxaAcerto, licoesAtivas, licoesTotal, porMercado };
}

// ── Lições ativas (para /licoes) ──────────────────────────────────────────────
export function getAllActiveLessons() {
  const db = loadDB();
  return db.lessons
    .filter((l) => l.active)
    .sort((a, b) => {
      const wDiff = (b.weight || 1) - (a.weight || 1);
      if (wDiff !== 0) return wDiff;
      return (b.applied_count || 0) - (a.applied_count || 0);
    })
    .slice(0, 15);
}

// ── Injeção em lote — 1 loadDB + 1 saveDB para N partidas ────────────────────
// analyses: array de { positives, lessons, calibration } vindos de analyzeMatch()
// predId: ID da sessão (string, ex: 'daily_20260410')
export function batchSaveAnalysis(analyses, predId) {
  const db  = loadDB();
  const now = new Date().toISOString();

  for (const { positives, lessons, calibration } of analyses) {
    // Padrões positivos
    for (const p of positives) {
      const dup = db.positivePatterns.find(x => x.market === p.market && x.directive === p.directive);
      if (dup) {
        dup.confirmed_count++;
        dup.last_seen = now;
      } else {
        db.positivePatterns.push({
          id: randomUUID(), market: p.market, competition: p.competition,
          directive: p.directive, source_prediction_id: predId,
          created_at: now, last_seen: now, confirmed_count: 0, active: true,
        });
      }
    }

    // Lições de calibração
    for (const l of lessons) {
      const dup = db.lessons.find(x => x.market === l.market && x.directive === l.directive);
      if (dup) {
        dup.applied_count++;
        dup.last_seen = now;
      } else {
        db.lessons.push({
          id: randomUUID(), market: l.market, competition: l.competition,
          directive: l.directive, error_type: l.errorType || 'calibration',
          source_prediction_id: predId, created_at: now, last_seen: now,
          applied_count: 0, active: true,
          weight: l.errorType === 'model_failure' ? 2 : 1,
        });
      }
    }

    // Calibração por mercado
    for (const o of calibration) {
      _updateCalibration(db, o.market, o.probabilidade, o.acertou, o.competition);
      if (o.acertou) db.stats.acertos++; else db.stats.erros++;
      db.stats.total++;
    }
  }

  // Retém os 50 melhores padrões positivos
  if (db.positivePatterns.length > 50) {
    db.positivePatterns = db.positivePatterns
      .sort((a, b) => {
        const diff = (b.confirmed_count || 0) - (a.confirmed_count || 0);
        return diff !== 0 ? diff : new Date(b.last_seen) - new Date(a.last_seen);
      })
      .slice(0, 50);
  }

  saveDB(db);
  return db;
}

// ── Limpeza de predições orphaned (sem resultado após 7 dias) ─────────────────
export function purgeOrphanedPredictions(daysOld = 7) {
  const db      = loadDB();
  const cutoff  = Date.now() - daysOld * 86_400_000;
  const before  = db.predictions.length;

  db.predictions = db.predictions.filter((p) => {
    if (p.result_id) return true; // tem resultado — manter
    const age = new Date(p.created_at).getTime();
    return age >= cutoff; // recente — manter
  });

  const purged = before - db.predictions.length;
  if (purged > 0) {
    console.log(`[PIE] 🧹 ${purged} predição(ões) orphaned removidas (> ${daysOld} dias sem resultado)`);
    saveDB(db);
  }
  return purged;
}

// ── Registrar melhoria aplicada ao modelo (APEX changelog) ───────────────────
/**
 * Persiste no PIE um registro imutável de cada melhoria aplicada ao modelo.
 * Serve como auditoria técnica e base para correlacionar mudanças de accuracy.
 *
 * @param {{ code, title, description, files_modified, metrics_before, metrics_after, author }} entry
 */
export function saveModelImprovement({
  code,             // ex: 'APEX-A', 'APEX-B'
  title,            // ex: 'Correlação cruzada em parlays'
  description,      // descrição técnica do que foi feito
  files_modified,   // array de paths modificados
  metrics_before,   // { accuracy_btts, accuracy_o15, roi, ... }
  metrics_after,    // idem
  author = 'APEX',  // quem aplicou
}) {
  const db = loadDB();
  if (!db.model_improvements) db.model_improvements = [];

  const entry = {
    id:               randomUUID(),
    code,
    title,
    description,
    files_modified:   files_modified || [],
    metrics_before:   metrics_before || null,
    metrics_after:    metrics_after  || null,
    author,
    applied_at:       new Date().toISOString(),
  };

  db.model_improvements.push(entry);
  saveDB(db);
  console.log(`[PIE] ✅ Melhoria ${code} registrada: ${title}`);
  return entry;
}

