/**
 * fullDataCollector.js — Coletor Completo de Dados (6 fontes paralelas)
 *
 * Enriquece matchData com dados adicionais de múltiplas fontes.
 * Falha em qualquer fonte não bloqueia as demais (Promise.allSettled).
 *
 * Fonte 1: SofaScore aggregator (já existente — importa como base)
 * Fonte 2: PIE DB — padrões históricos do par de times
 * Fonte 3: GoalsSniper intel — lambda/probabilidade Poisson
 * Fonte 4: BTTSSniper intel — btts streak/calibração
 * Fonte 5: Superbet cache — URL direta do jogo
 * Fonte 6: Quant — fair_odds + EV por mercado
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname }            from 'path';
import { fileURLToPath }            from 'url';
import { aggregateMatchData }       from '../scrapers/aggregator.js';
import { analyzeQuantitative }      from '../agents/quant.js';
import { loadDB }                   from '../pie/pie-storage.js';
import { lookupMatchUrl }           from '../scrapers/superbet-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Fonte 2 — PIE padrões históricos ─────────────────────────────────────────
function _collectPiePatterns(match, pieDB) {
  if (!pieDB?.patterns) return {};
  const hn = (match.home_team || '').toLowerCase().trim().substring(0, 8);
  const an = (match.away_team || '').toLowerCase().trim().substring(0, 8);
  const relevantes = Object.values(pieDB.patterns).filter(p => {
    const m = (p.match || '').toLowerCase();
    return m.includes(hn) && m.includes(an);
  });
  return { pie_historico: relevantes.slice(0, 20) };
}

// ── Fonte 3 — GoalsSniper intel do disco ─────────────────────────────────────
function _collectGoalsIntel(match) {
  try {
    const file = join(__dirname, '../../data/goals-sniper-intel.json');
    if (!existsSync(file)) return {};
    const db  = JSON.parse(readFileSync(file, 'utf-8'));
    const key = `${match.home_team}|${match.away_team}`;
    return db[key] ? { goals_sniper_intel: db[key] } : {};
  } catch { return {}; }
}

// ── Fonte 4 — BTTSSniper intel do disco ──────────────────────────────────────
function _collectBttsIntel(match) {
  try {
    const file = join(__dirname, '../../data/btts-sniper-intel.json');
    if (!existsSync(file)) return {};
    const db  = JSON.parse(readFileSync(file, 'utf-8'));
    const key = `${match.home_team}|${match.away_team}`;
    return db[key] ? { btts_sniper_intel: db[key] } : {};
  } catch { return {}; }
}

// ── Fonte 5 — Superbet URL cache ─────────────────────────────────────────────
function _collectSuperbetUrl(match) {
  try {
    const url = lookupMatchUrl(match.home_team, match.away_team, 'prelive');
    return url ? { superbet_url: url } : {};
  } catch { return {}; }
}

// ── Coletor principal ─────────────────────────────────────────────────────────

/**
 * collectFullData — enriquece matchData com todas as 6 fontes.
 *
 * @param {object} match    — objeto base: { sofascore_id, home_team, away_team, ... }
 * @param {object} [opts]   — { skipQuant: bool, pieDB: object|null }
 * @returns {object}        — matchData completo com campos extras merged
 */
export async function collectFullData(match, opts = {}) {
  const { skipQuant = false, pieDB: _pieDB } = opts;

  // Carrega PIE uma vez se não passado
  let pieDB = _pieDB;
  if (!pieDB) {
    try { pieDB = loadDB(); } catch { pieDB = null; }
  }

  // Executa 6 fontes em paralelo
  const [
    aggregatorResult,
    quantResult,
  ] = await Promise.allSettled([
    aggregateMatchData(match.sofascore_id || match.match_id, match),
    skipQuant ? Promise.resolve(null) : analyzeQuantitative(match),
  ]);

  const base     = aggregatorResult.status === 'fulfilled' ? (aggregatorResult.value || {}) : {};
  const quant    = quantResult.status === 'fulfilled' ? quantResult.value : null;

  // Fontes síncronas
  const pieExtra    = _collectPiePatterns(match, pieDB);
  const goalsIntel  = _collectGoalsIntel(match);
  const bttsIntel   = _collectBttsIntel(match);
  const sbUrl       = _collectSuperbetUrl(match);

  // Merge — matchData base + enriquecimentos
  const enriched = {
    ...match,
    ...base,
    ...pieExtra,
    ...goalsIntel,
    ...bttsIntel,
    ...sbUrl,
    _quant:    quant,        // quant result disponível para DeepAnalysisEngine (D8)
    _sources: {
      aggregator: aggregatorResult.status,
      quant:      quantResult.status,
      pie:        pieExtra.pie_historico?.length ?? 0,
      goals_intel: !!goalsIntel.goals_sniper_intel,
      btts_intel:  !!bttsIntel.btts_sniper_intel,
      superbet_url: !!sbUrl.superbet_url,
    },
  };

  return enriched;
}
