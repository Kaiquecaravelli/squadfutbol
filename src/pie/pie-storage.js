/**
 * PIE Storage — Protocolo de Inteligência Evolutiva
 * CAMADA MONGODB ATLAS — Migration Serverless 2026-05-13
 *
 * Antigo: persistence via readFileSync/writeFileSync em pie.json
 * Novo: operações assíncronas com Mongoose
 */

import { randomUUID } from 'crypto';
import { connectDB, isConnected, disconnectDB } from '../db/mongo-connection.js';
import { Prediction, Result, Lesson, Calibration, LambdaFator } from '../db/models/index.js';

// ── Cache em memória para leituras frequentes (TTL: 30s) ───────────────────────
let _dbCache = null;
let _dbCacheTs = 0;
const DB_CACHE_TTL = 30_000;

// ── Cache de calibração (mantido do design original) ───────────────────────────
let _calibrationCache = null;
let _calibrationCacheTs = 0;
const CALIBRATION_CACHE_TTL = 5 * 60_000;

// ── Garantia de conexão antes de qualquer operação ─────────────────────────────
async function _ensureConnection() {
  if (!isConnected()) {
    await connectDB();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÕES PÚBLICAS — API idêntica ao design original
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Carrega o "banco virtual" — agrega dados das collections MongoDB.
 * Usa cache em memória para evitar queries redundantes.
 * @returns {Promise<Object>}
 */
export async function loadDB() {
  await _ensureConnection();

  const now = Date.now();
  if (_dbCache && now - _dbCacheTs < DB_CACHE_TTL) {
    return _dbCache;
  }

  // Carrega dados de todas as collections em paralelo
  const [predictions, results, lessons, calibrationDocs, lambdaDocs] = await Promise.all([
    Prediction.find().sort({ created_at: -1 }).limit(5000).lean(),
    Result.find().sort({ registered_at: -1 }).limit(5000).lean(),
    Lesson.find({ active: true }).lean(),
    Calibration.find().lean(),
    LambdaFator.find().lean(),
  ]);

  // Monta objeto no formato original
  _dbCache = {
    predictions,
    results,
    lessons,
    positivePatterns: [], // TODO: implementar positivePatterns collection
    agentLogs: [],
    calibration: calibrationDocs.reduce((acc, c) => {
      acc[c.market] = {
        total: c.total,
        hits: c.hits,
        byRange: Object.fromEntries(c.byRange || new Map()),
        byCompetition: Object.fromEntries(c.byCompetition || new Map()),
      };
      return acc;
    }, {}),
    model_improvements: [],
    lambdaFatores: lambdaDocs.reduce((acc, f) => {
      acc[f.competition] = f.fator;
      return acc;
    }, {}),
    confrontos: [], // TODO: implementar confrontos collection
    stats: _calculateStats(predictions, results),
  };

  _dbCacheTs = now;
  return _dbCache;
}

// Calcula estatísticas globais
function _calculateStats(predictions, results) {
  const withResults = predictions.filter(p => p.result_id);
  const acertos = results.filter(r =>
    r.market_outcomes?.some(o => o.acertou === true)
  ).length;
  const erros = results.filter(r =>
    r.market_outcomes?.some(o => o.acertou === false)
  ).length;

  return {
    total: predictions.length,
    acertos,
    erros,
    nao_verificaveis: results.length - acertos - erros,
  };
}

/**
 * Versão síncrona (legacy) — mantém compatibilidade com código síncrono.
 * Carga cache se necessário.
 */
export function loadDBSync() {
  // Para uso síncrono, retorna o cache se existir
  // Caso contrário, o código chamante deve usar loadDB() async
  return _dbCache || { predictions: [], results: [], lessons: [], calibration: {}, lambdaFatores: {} };
}

/**
 * Salva predição — Insere no MongoDB
 * @returns {Promise<string>} id da predição
 */
export async function savePrediction({ idx, matchData, markets, sofascoreId, kickoffTime }) {
  await _ensureConnection();

  const id = randomUUID();
  const sfId = sofascoreId || matchData.sofascore_id || matchData.match_id;
  const sofascoreIdFinal = sfId && /^\d+$/.test(String(sfId)) ? Number(sfId) : null;

  const pred = new Prediction({
    _id: id,
    idx,
    match_id: `${(matchData.match || '').replace(/\s+/g, '_')}_${matchData.date || ''}`,
    match_name: matchData.match || '',
    competition: matchData.competition || '',
    match_date: matchData.date || '',
    sofascore_id: sofascoreIdFinal,
    kickoff_time: kickoffTime || matchData.kickoff_time || null,
    xg_home: matchData.xg_home ?? null,
    xg_away: matchData.xg_away ?? null,
    markets: markets.map((m) => ({
      market: m.market,
      recommendation: m.recommendation,
      probabilidade: m.probabilidade,
      confianca: m.confianca || 0,
      odds_minima: m.odds_minima || null,
      ev_estimado: m.odds_minima && m.probabilidade != null
        ? (() => {
            const ev = ((Number(m.probabilidade) / 100) * Number(m.odds_minima) - 1) * 100;
            return isNaN(ev) ? null : Number(ev.toFixed(1));
          })()
        : null,
    })),
    created_at: new Date(),
    result_id: null,
  });

  await pred.save();
  _invalidateCache();
  return id;
}

/**
 * Salva resultado real — Insere Result + atualiza Prediction.linkada
 */
export async function saveResult({ predictionId, matchName, placarReal, marketOutcomes, competition = '' }) {
  await _ensureConnection();

  if (!matchName || typeof matchName !== 'string') return null;
  if (!Array.isArray(marketOutcomes) || !marketOutcomes.length) return null;

  const placarValido = /^\d{1,2}-\d{1,2}$/.test(placarReal || '');
  const placarFinal = placarValido ? placarReal : null;

  const id = randomUUID();
  const result = new Result({
    _id: id,
    prediction_id: predictionId || null,
    match_name: matchName,
    placar_real: placarFinal,
    competition: competition || '',
    market_outcomes: marketOutcomes,
    registered_at: new Date(),
  });

  await result.save();

  // Link prediction → result
  if (predictionId) {
    await Prediction.findByIdAndUpdate(predictionId, { result_id: id });
  }

  // Atualiza calibração para cada mercado
  for (const o of marketOutcomes) {
    if (!o.market) continue;
    const prob = (o.probabilidade != null && !isNaN(o.probabilidade)) ? Number(o.probabilidade) : null;
    if (o.acertou !== null && prob !== null) {
      await _updateCalibrationMongo(o.market, prob, o.acertou, competition);
    }
  }

  _invalidateCache();
  invalidateCalibrationCache();
  return id;
}

/**
 * Atualiza calibração no MongoDB (upsert)
 */
async function _updateCalibrationMongo(market, prob, acertou, competition) {
  const key = normalizeMarketKey(market);
  const range = _probRange(Number(prob) || 0);
  const hit = acertou === true ? 1 : 0;

  const update = {
    $inc: { total: 1, hits: hit },
    $set: { updated_at: new Date() },
  };

  // Atualiza byRange
  update.$inc[`byRange.${range}.total`] = 1;
  update.$inc[`byRange.${range}.hits`] = hit;

  // Atualiza byCompetition se houver
  if (competition) {
    const comp = competition.slice(0, 40);
    update.$inc[`byCompetition.${comp}.total`] = 1;
    update.$inc[`byCompetition.${comp}.hits`] = hit;
  }

  await Calibration.findOneAndUpdate(
    { market: key },
    update,
    { upsert: true, setDefaultsOnInsert: true }
  );
}

/**
 * Salva lição aprendida
 */
export async function saveLesson({ market, competition, directive, errorType, predictionId }) {
  await _ensureConnection();

  const existing = await Lesson.findOne({ market, directive });
  if (existing) {
    existing.applied_count++;
    existing.last_seen = new Date();
    await existing.save();
    return existing._id;
  }

  const lesson = new Lesson({
    market,
    competition,
    directive,
    error_type: errorType,
    weight: errorType === 'model_failure' ? 2 : 1,
    active: true,
    applied_count: 0,
    source_prediction_id: predictionId,
    created_at: new Date(),
    last_seen: new Date(),
  });

  await lesson.save();
  _invalidateCache();
  return lesson._id;
}

/**
 * Salva padrão positivo
 * TODO: Implementar positivePatterns collection
 */
export async function savePositiveLesson({ market, competition, directive, predictionId }) {
  // Por enquanto, salva como lesson com weight 0
  await saveLesson({ market, competition, directive, errorType: 'positive_pattern', predictionId });
}

/**
 * Retorna padrões positivos ativos
 */
export async function getPositivePatterns(market) {
  await _ensureConnection();
  // Por enquanto, busca lessons com errorType positive_pattern
  return Lesson.find({
    active: true,
    errorType: 'positive_pattern',
    $or: [{ market: market }, { market: { $exists: false } }],
  }).limit(2).lean();
}

/**
 * Retorna lições ativas
 */
export async function getActiveLessons(market, competition) {
  await _ensureConnection();
  return Lesson.find({
    active: true,
    $or: [{ market: market }, { market: { $exists: false } }],
    $or: [
      { competition: competition },
      { competition: { $exists: false } },
    ],
  })
    .sort({ weight: -1, applied_count: -1, last_seen: -1 })
    .limit(4)
    .lean();
}

/**
 * Retorna estatísticas globais
 */
export async function getStats() {
  const db = await loadDB();
  const { total, acertos, erros, nao_verificaveis } = db.stats;
  const verificaveis = acertos + erros;
  const taxaAcerto = verificaveis > 0 ? ((acertos / verificaveis) * 100).toFixed(1) : null;

  const licoesAtivas = await Lesson.countDocuments({ active: true });
  const licoesTotal = await Lesson.countDocuments();

  const porMercado = {};
  for (const r of db.results || []) {
    for (const o of r.market_outcomes || []) {
      if (!porMercado[o.market]) porMercado[o.market] = { acertos: 0, erros: 0 };
      if (o.acertou === true) porMercado[o.market].acertos++;
      else if (o.acertou === false) porMercado[o.market].erros++;
    }
  }

  return { total, acertos, erros, nao_verificaveis, verificaveis, taxaAcerto, licoesAtivas, licoesTotal, porMercado };
}

/**
 * Retorna todas as lições ativas
 */
export async function getAllActiveLessons() {
  await _ensureConnection();
  return Lesson.find({ active: true })
    .sort({ weight: -1, applied_count: -1 })
    .limit(15)
    .lean();
}

// ── Calibração (mantido do original) ─────────────────────────────────────────

export function normalizeMarketKey(m) {
  if (!m) return m;
  const s = m.toLowerCase().trim();
  if (s === 'btts sim' || s === 'btts não' || s === 'btts nao' ||
      s.includes('ambas marcam') || s === 'btts') return 'BTTS';
  const goalsM = s.match(/^(over|under)\s+([\d.]+)\s+gols?$/i);
  if (goalsM) return `${goalsM[1].charAt(0).toUpperCase() + goalsM[1].slice(1)} ${goalsM[2]}`;
  const cornersM = s.match(/^over\s+(corners?\s+)?([\d.]+)/i);
  if (cornersM && s.includes('corner')) return `Over Corners ${cornersM[2]}`;
  if (s.startsWith('resultado final')) return 'Resultado Final';
  if (s.includes('correct score') || s.includes('placar exato') || s.match(/^\d+-\d+$/)) return 'Correct Score';
  if (s === '1x' || s === 'dupla chance casa' || s === 'dupla chance 1x') return '1X';
  if (s === 'x2' || s === 'dupla chance fora' || s === 'dupla chance x2') return 'X2';
  if (s === '12' || s === 'dupla chance semempate' || s === 'vitória de qualquer equipe') return '12';
  if (s === 'home win' || s === 'vitória casa' || s === '1') return 'Home Win';
  if (s === 'away win' || s === 'vitória fora' || s === '2') return 'Away Win';
  if (s === 'draw' || s === 'empate' || s === 'x') return 'Draw';
  return m;
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

// ── Cache de calibração — evita leituras repetidas ────────────────────────────

function _getCalibrationDB() {
  if (_calibrationCache && Date.now() - _calibrationCacheTs < CALIBRATION_CACHE_TTL) {
    return _calibrationCache;
  }
  // readings
  return null; // será populado via loadDB
}

export function invalidateCalibrationCache() {
  _calibrationCache = null;
  _calibrationCacheTs = 0;
}

function _invalidateCache() {
  _dbCache = null;
  _dbCacheTs = 0;
}

// ── Lambda Fatores ───────────────────────────────────────────────────────────

export async function getLambdaFator(competition) {
  if (!competition) return 1.0;
  await _ensureConnection();
  const doc = await LambdaFator.findOne({ competition });
  return doc ? doc.fator : 1.0;
}

export async function setLambdaFator(competition, fator) {
  if (!competition) return;
  await _ensureConnection();
  await LambdaFator.findOneAndUpdate(
    { competition },
    {
      competition,
      fator: Math.max(0.75, Math.min(1.25, Number(fator))),
      updated_at: new Date(),
    },
    { upsert: true }
  );
  invalidateCalibrationCache();
}

// ── Batch operations ──────────────────────────────────────────────────────────

export async function batchSaveAnalysis(analyses, predId) {
  await _ensureConnection();
  const now = new Date();

  // Processa cada análise
  for (const { positives, lessons, calibration } of analyses) {
    // Padrões positivos → lessons
    for (const p of positives) {
      await savePositiveLesson({ ...p, predictionId: predId });
    }

    // Lições
    for (const l of lessons) {
      await saveLesson({ ...l, predictionId: predId });
    }

    // Calibração
    for (const o of calibration) {
      await _updateCalibrationMongo(o.market, o.probabilidade, o.acertou, o.competition);
    }
  }

  _invalidateCache();
  invalidateCalibrationCache();
}

// ── Exporta função de conexão para uso externo ───────────────────────────────

export { connectDB, disconnectDB, isConnected };