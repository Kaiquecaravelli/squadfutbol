/**
 * PIE Storage — Protocolo de Inteligência Evolutiva
 * Camada de persistência: predições, resultados, lições, calibração e logs de agentes.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dir   = dirname(fileURLToPath(import.meta.url));
const DB_PATH       = join(__dir, '../../data/pie.json');
const SNAPSHOT_PATH = join(__dir, '../../data/pie-snapshots.jsonl');
const LESSONS_PATH  = join(__dir, '../../data/pie-lessons.json');

// ── DB Schema ─────────────────────────────────────────────────────────────────
const EMPTY_DB = () => ({
  predictions:       [],
  results:           [],
  lessons:           [],
  positivePatterns:  [],  // reforços de padrões bem-sucedidos
  agentLogs:         [],  // todos os outputs dos agentes (aprovados e não-aprovados)
  calibration:       {},  // { [market]: { total, hits, byRange, byCompetition } }
  model_improvements: [], // log de melhorias aplicadas no modelo (APEX changelog)
  lambdaFatores:     {},  // { [competition]: fator } — calibrado pelo feed-loop (range 0.75-1.25)
  confrontos:        [],  // lições estruturadas com diagnóstico pré-análise vs real
  stats: { total: 0, acertos: 0, erros: 0, nao_verificaveis: 0 },
});

// ── Helpers para pie-lessons.json separado ────────────────────────────────────
function _loadLessons() {
  if (!existsSync(LESSONS_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(LESSONS_PATH, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function _saveLessons(lessons) {
  writeFileSync(LESSONS_PATH, JSON.stringify(Array.isArray(lessons) ? lessons : [], null, 2), 'utf-8');
}

export function loadDB() {
  if (!existsSync(DB_PATH)) {
    const db = EMPTY_DB();
    writeFileSync(DB_PATH, JSON.stringify({ ...db, lessons: [] }, null, 2), 'utf-8');
    _saveLessons([]);
    return db;
  }
  let db;
  try {
    db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    console.error(`[PIE] pie.json corrompido: ${e.message} — restaurando backup`);
    const bak = DB_PATH + '.backup';
    if (existsSync(bak)) {
      try { db = JSON.parse(readFileSync(bak, 'utf-8')); }
      catch { db = EMPTY_DB(); }
    } else {
      db = EMPTY_DB();
    }
  }
  // Migração: garante campos novos em DBs antigos
  if (!db.calibration)        db.calibration        = {};
  if (!db.agentLogs)          db.agentLogs          = [];
  if (!db.positivePatterns)   db.positivePatterns   = [];
  if (!db.model_improvements) db.model_improvements = [];
  if (!db.lambdaFatores)      db.lambdaFatores      = {};
  if (!db.confrontos)         db.confrontos         = [];

  // Migração automática: se pie.json ainda tem lições e pie-lessons.json ainda não existe
  if (Array.isArray(db.lessons) && db.lessons.length > 0 && !existsSync(LESSONS_PATH)) {
    console.log(`[PIE] Migrando ${db.lessons.length} lições para pie-lessons.json...`);
    _saveLessons(db.lessons);
    db.lessons = [];
    writeFileSync(DB_PATH, JSON.stringify({ ...db, lessons: [] }, null, 2), 'utf-8');
    console.log('[PIE] Migração concluída. pie.json aliviado.');
  }

  // Sempre carrega lições do arquivo separado
  db.lessons = _loadLessons();
  return db;
}

function saveDB(db) {
  // Escrita atômica: grava em arquivo temporário e depois renomeia
  // Garante que pie.json nunca fica em estado parcial/corrompido (crash-safe)
  try { if (existsSync(DB_PATH)) copyFileSync(DB_PATH, DB_PATH + '.backup'); } catch {}
  const { lessons, ...dbWithoutLessons } = db;
  _saveLessons(lessons || []);
  const tmpPath = DB_PATH + '.tmp';
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify({ ...dbWithoutLessons, lessons: [] }, null, 2), 'utf-8');
    renameSync(tmpPath, DB_PATH); // operação atômica no SO
  } catch (e) {
    // Fallback para escrita direta se rename falhar (ex: cross-device)
    try { writeFileSync(DB_PATH, JSON.stringify({ ...dbWithoutLessons, lessons: [] }, null, 2), 'utf-8'); } catch {}
    console.error(`[PIE] saveDB fallback (rename falhou): ${e.message}`);
  }
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
      ev_estimado:    (m.odds_minima && m.probabilidade != null && !isNaN(m.probabilidade))
        ? (() => {
            const ev = ((Number(m.probabilidade) / 100) * Number(m.odds_minima) - 1) * 100;
            return isNaN(ev) ? null : Number(ev.toFixed(1));
          })()
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
  // Validações de entrada
  if (!matchName || typeof matchName !== 'string') return null;
  if (!Array.isArray(marketOutcomes) || !marketOutcomes.length) return null;

  // Valida formato do placar (ex: "2-1", "0-0")
  const placarValido = /^\d{1,2}-\d{1,2}$/.test(placarReal || '');
  const placarFinal  = placarValido ? placarReal : null;

  const db = loadDB();
  const id = randomUUID();

  db.results.push({
    id,
    prediction_id:   predictionId || null,
    match_name:      matchName,
    placar_real:     placarFinal,
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
    if (!o.market) continue; // ignora outcomes sem mercado definido

    if (o.acertou === true)       db.stats.acertos++;
    else if (o.acertou === false) db.stats.erros++;
    else                          db.stats.nao_verificaveis = (db.stats.nao_verificaveis || 0) + 1;

    const prob = (o.probabilidade != null && !isNaN(o.probabilidade)) ? Number(o.probabilidade) : null;
    if (o.acertou !== null && prob !== null) {
      _updateCalibration(db, o.market, prob, o.acertou, comp);
    }
  }

  saveDB(db);
  invalidateCalibrationCache(); // cache desatualizado após novo resultado
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
  const calibration = _getCalibrationDB();
  const calib = calibration[normalizeMarketKey(market)] || calibration[market];
  if (!calib || calib.total < 5) return null; // sem dados suficientes

  const range = _probRange(Number(prob) || 0);
  const byR   = calib.byRange[range];
  if (!byR || byR.total < 3) {
    // Usa taxa global
    return { accuracy: (calib.hits / calib.total * 100).toFixed(1), samples: calib.total, range: 'geral' };
  }
  return { accuracy: (byR.hits / byR.total * 100).toFixed(1), samples: byR.total, range };
}

// ── Cache de calibração em memória — evita leituras repetidas de pie.json ────
let _calibrationCache = null;
let _calibrationCacheTs = 0;
const CALIBRATION_CACHE_TTL = 5 * 60_000; // 5 min

function _getCalibrationDB() {
  if (_calibrationCache && Date.now() - _calibrationCacheTs < CALIBRATION_CACHE_TTL) {
    return _calibrationCache;
  }
  const db = loadDB();
  _calibrationCache = db.calibration || {};
  _calibrationCacheTs = Date.now();
  return _calibrationCache;
}

/** Invalida o cache de calibração — chamar após saveResult/batchSaveAnalysis */
export function invalidateCalibrationCache() {
  _calibrationCache = null;
}

// ── Estatísticas completas de calibração para um agente ──────────────────────
export function getAgentCalibration(market) {
  const calibration = _getCalibrationDB();
  const calib = calibration[normalizeMarketKey(market)] || calibration[market];
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
  invalidateCalibrationCache(); // cache desatualizado após batch de análises
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



// ── Snapshot Diário — evolução histórica da calibração ───────────────────────
/**
 * Grava um snapshot instantâneo da calibração do PIE em data/pie-snapshots.jsonl.
 * Chamado ao final de cada execução do pipeline diário.
 * Cada linha é um JSON independente (JSONL) — append-only, nunca sobrescreve.
 *
 * Estrutura de cada linha:
 * { ts, date, globalRate, totalOutcomes, markets: { [market]: { acc, total } } }
 */
export function savePieSnapshot() {
  const db  = loadDB();
  const now = new Date();

  const verificaveis = db.stats.acertos + db.stats.erros;
  const globalRate   = verificaveis > 0
    ? parseFloat(((db.stats.acertos / verificaveis) * 100).toFixed(2))
    : null;

  const markets = {};
  for (const [market, cal] of Object.entries(db.calibration)) {
    if (cal.total >= 5) {  // só mercados com amostras suficientes
      markets[market] = {
        acc:   parseFloat(((cal.hits / cal.total) * 100).toFixed(2)),
        total: cal.total,
      };
    }
  }

  const snap = {
    ts:            now.toISOString(),
    date:          now.toISOString().slice(0, 10),
    globalRate,
    totalOutcomes: verificaveis,
    markets,
  };

  try {
    appendFileSync(SNAPSHOT_PATH, JSON.stringify(snap) + '\n', 'utf-8');
    // Rotação: mantém apenas snapshots dos últimos 7 dias (evita crescimento infinito em disco)
    _rotateSnapshots();
  } catch (e) {
    console.warn('[PIE] Falha ao gravar snapshot:', e.message);
  }

  return snap;
}

function _rotateSnapshots() {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return;
    const cutoff = Date.now() - 7 * 86_400_000;
    const raw    = readFileSync(SNAPSHOT_PATH, 'utf-8');
    const lines  = raw.split('\n').filter(Boolean);
    if (lines.length < 200) return; // não rotaciona se ainda pequeno
    const kept   = lines.filter(l => { try { return JSON.parse(l).ts > new Date(cutoff).toISOString(); } catch { return false; } });
    if (kept.length < lines.length) {
      writeFileSync(SNAPSHOT_PATH, kept.join('\n') + '\n', 'utf-8');
      console.log(`[PIE] Rotação de snapshots: ${lines.length - kept.length} entradas antigas removidas`);
    }
  } catch { /* silencioso — rotação é melhoramento não crítico */ }
}

/**
 * Carrega todos os snapshots históricos.
 * @param {number} [limit] — máximo de entradas (mais recentes primeiro)
 */
export function loadPieSnapshots(limit = 90) {
  try {
    const lines = readFileSync(SNAPSHOT_PATH, 'utf-8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return lines.slice(-limit).reverse();
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// SISTEMA DE AUTOALIMENTAÇÃO — Feed Loop + Confronto Engine
// ═══════════════════════════════════════════════════════════════════════════

// ── Lambda Fatores — calibração per-liga pelo feed loop ──────────────────────
/**
 * Retorna o fator lambda aprendido para uma competição.
 * Default: 1.0 (neutro) se ainda não calibrado.
 */
export function getLambdaFator(competition) {
  if (!competition) return 1.0;
  const db = loadDB();
  const fator = db.lambdaFatores?.[competition];
  return (fator != null && !isNaN(fator)) ? Number(fator) : 1.0;
}

/**
 * Salva ou atualiza o fator lambda para uma competição.
 * Range permitido: [0.75, 1.25].
 */
export function setLambdaFator(competition, fator) {
  if (!competition) return;
  const db = loadDB();
  db.lambdaFatores[competition] = Math.max(0.75, Math.min(1.25, Number(fator)));
  saveDB(db);
}

// ── Lição de confronto — diagnóstico estruturado por jogo ────────────────────
/**
 * Salva confronto completo (diagnóstico pré-análise vs real) como lição estruturada.
 * Imutável após salvo — nunca deletar.
 */
export function saveConfronto({ predictionId, matchName, competition, market, acertou, confronto }) {
  const db  = loadDB();
  const now = new Date().toISOString();

  const entrada = {
    id:            randomUUID(),
    prediction_id: predictionId || null,
    match_name:    matchName    || '',
    competition:   competition  || '',
    market:        market       || '',
    acertou:       acertou,
    confronto,                        // objeto completo do confronto-engine
    processado:    false,             // marcado pelo feed-loop após processar
    salvo_em:      now,
  };

  db.confrontos.push(entrada);

  // Limitar histórico a 500 confrontos (mantém os mais recentes)
  if (db.confrontos.length > 500) db.confrontos = db.confrontos.slice(-500);

  saveDB(db);
  return entrada.id;
}

// ── Lições de confronto para o feed loop ─────────────────────────────────────
/**
 * Retorna confrontos com diagnóstico para processamento do feed loop.
 * @param {{ dias, apenasNaoProcessadas }} opts
 */
export function getLicoesConfronto({ dias = 30, apenasNaoProcessadas = false } = {}) {
  const db     = loadDB();
  const cutoff = new Date(Date.now() - dias * 86_400_000).toISOString();

  return db.confrontos.filter(c => {
    if (c.salvo_em < cutoff) return false;
    if (apenasNaoProcessadas && c.processado) return false;
    return true;
  });
}

/**
 * Marca confrontos como processados pelo feed loop (evita reprocessar).
 * @param {string[]} ids — lista de IDs dos confrontos processados
 */
export function marcarLicoesProcessadas(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const db  = loadDB();
  const set = new Set(ids);
  let alterou = false;

  for (const c of db.confrontos) {
    if (set.has(c.id) && !c.processado) {
      c.processado   = true;
      c.processado_em = new Date().toISOString();
      alterou = true;
    }
  }

  if (alterou) saveDB(db);
}

// ── Cache de lambdaFatores para quant.js (leitura frequente) ─────────────────
let _lambdaFatoresCache     = null;
let _lambdaFatoresCacheTs   = 0;
const LAMBDA_CACHE_TTL = 10 * 60_000; // 10 min

/**
 * Versão com cache para uso no quant.js (evita leitura de disco por jogo).
 * Retorna 1.0 se não há fator para a competição.
 */
export function getLambdaFatorSync(competition) {
  if (!competition) return 1.0;
  const now = Date.now();
  if (!_lambdaFatoresCache || now - _lambdaFatoresCacheTs > LAMBDA_CACHE_TTL) {
    try {
      const db = loadDB();
      _lambdaFatoresCache   = db.lambdaFatores || {};
      _lambdaFatoresCacheTs = now;
    } catch {
      return 1.0;
    }
  }
  const fator = _lambdaFatoresCache[competition];
  return (fator != null && !isNaN(fator)) ? Number(fator) : 1.0;
}
