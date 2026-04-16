/**
 * kill-zone.js — Kill Zone Gate Universal
 *
 * Intervalo de confiança 60-70% → 0% de precisão em 880+ amostras (8 mercados).
 * Este módulo centraliza a detecção, logging e tracking de sinais Kill Zone.
 *
 * Usado em: funnel-pre-live.js · funnel-live-2t.js
 *
 * Exporta:
 *   KILL_ZONE_THRESHOLD              → 70  (limiar padrão)
 *   isKillZone(prob, mkt?, comp?)   → boolean (Module 4: floor calibrado por liga quando disponível)
 *   getKillZoneFloor(mkt, comp)     → number  (65–70, retorna floor calibrado ou padrão 70)
 *   trackKillZone(r, md, src)       → void (persiste em data/kill-zone-log.json)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirKZ = dirname(fileURLToPath(import.meta.url));
const KZ_LOG  = join(__dirKZ, '../../data/kill-zone-log.json');

// ── Limiar Kill Zone ──────────────────────────────────────────────────────────
// Calibrado com 880+ amostras reais do PIE:
//   Over 2.5 60-70%: 0/204 hits (0%)
//   Over 3.5 60-70%: 0/98 hits  (0%)
//   Corners 6.5-8.5 60-70%: 0/338 hits (0%)
//   YC 2.5-4.5 60-70%: 0/240 hits (0%)
export const KILL_ZONE_THRESHOLD = 70;

// ── Module 4 — Calibrated KZ Floor (2026-04-16) ───────────────────────────────
//
// Ligas/mercados com evidências de que a Kill Zone começa abaixo do padrão 70%.
// Critério de inclusão: n ≥ 50 amostras na faixa 65-70% com precisão ≥ 70%.
// Floor mínimo absoluto: 65% (nunca abaixo, independente de dados).
//
// Status atual: nenhuma liga atingiu n≥50 na faixa 65-70% ainda.
// Quando uma liga atingir o critério, adicionar entrada aqui e em CALIBRATED_KZ_FLOORS.
// Diagnóstico: npm run pie-diag para ver distribuição de probabilidades por liga.
//
// Formato: { 'competição_lowercase:mercado': floor }
// Exemplo: { 'brasileirão betano:Over Corners 6.5': 67 }
const CALIBRATED_KZ_FLOORS = {
  // Futuras entradas — aguarda dados (n≥50 na faixa 65-70% com precisão ≥70%):
  //
  // 'brasileirão betano:Over Corners 6.5': 67, // xG alto = mais escanteios, testar quando n≥50
  // 'bundesliga:Over Corners 6.5': 67,          // mesmo raciocínio
  // 'laliga:Over 1.5': 68,                       // Tier 2 com base rate 84% — validar faixa 68-70%
};

/**
 * Retorna o floor Kill Zone para um mercado/liga específicos.
 *
 * Under markets têm floor REDUZIDO (62%) porque a lógica é invertida:
 *   Uma liga com Over 1.5 = 35% implica Under 1.5 ≈ 65% — fora da Kill Zone de Over.
 *   A Kill Zone de 70% se baseia em dados de Over/Corners/YC, NÃO em Under.
 *   Aplicar 70% a Under bloquearia mercados que são naturalmente corretos.
 *
 * Floor mínimo absoluto: 62% para Under (proteção conservadora até n≥30).
 * Floor padrão para Over/BTTS/Corners: 70% (calibrado em 880+ amostras).
 *
 * @param {string} market      — mercado ('Over 2.5', 'Under 1.5', 'Over Corners 6.5', etc.)
 * @param {string} competition — nome da competição (case-insensitive)
 * @returns {number}           — floor em % (62–70)
 */
export function getKillZoneFloor(market = '', competition = '') {
  const mkt = (market || '').trim();

  // Under markets: Kill Zone começa mais abaixo — lógica inversa de Over
  // Under 1.5/2.5/3.5: floor 62% (conservador até calibração real com n≥30)
  if (/^under\s*[\d.]+$/i.test(mkt)) return 62;

  // Calibração per-liga (Over/Corners — aguarda n≥50 na faixa 65-70%)
  const key  = `${competition.toLowerCase()}:${market}`;
  const floor = CALIBRATED_KZ_FLOORS[key];
  if (typeof floor === 'number') {
    return Math.max(65, Math.min(floor, KILL_ZONE_THRESHOLD)); // clamp [65, 70]
  }
  return KILL_ZONE_THRESHOLD; // padrão: 70
}

/**
 * Retorna true se a probabilidade está na Kill Zone para a liga+mercado específicos.
 * Usa floor calibrado por liga quando disponível (Module 4).
 *
 * @param {number} prob        — probabilidade (0-100)
 * @param {string} market      — mercado (opcional — usa floor padrão se omitido)
 * @param {string} competition — competição (opcional)
 */
export function isKillZone(prob, market = '', competition = '') {
  if (typeof prob !== 'number') return false;
  const floor = getKillZoneFloor(market, competition);
  return prob < floor;
}

// ── Tracker ───────────────────────────────────────────────────────────────────
function _loadLog() {
  try {
    return JSON.parse(readFileSync(KZ_LOG, 'utf8'));
  } catch {
    return {
      summary: {
        total_blocked: 0,
        by_market:     {},
        by_source:     { prelive: 0, 'superodds-2t': 0, live: 0 },
        last_updated:  null,
      },
      log: [],
    };
  }
}

function _saveLog(data) {
  try { writeFileSync(KZ_LOG, JSON.stringify(data, null, 2), 'utf8'); }
  catch { /* não bloqueia o pipeline */ }
}

/**
 * Registra um sinal bloqueado pela Kill Zone Gate.
 *
 * @param {object} result    — { mercado, probabilidade, confianca }
 * @param {object} matchData — dados da partida
 * @param {string} source    — pipeline de origem ('prelive' | 'superodds-2t' | 'live')
 */
export function trackKillZone(result, matchData, source = 'prelive') {
  const kz = _loadLog();

  const mercado = result.mercado || result.market || 'unknown';
  const now     = new Date().toISOString();

  // Contadores
  kz.summary.total_blocked++;
  kz.summary.by_market[mercado]  = (kz.summary.by_market[mercado]  || 0) + 1;
  kz.summary.by_source[source]   = (kz.summary.by_source[source]   || 0) + 1;
  kz.summary.last_updated = now;

  // Log detalhado (mantém últimas 500 entradas para não inflar o arquivo)
  kz.log.push({
    ts:            now,
    source,
    match:         matchData?.match || matchData?.match_name || '',
    competition:   matchData?.competition || matchData?.league || '',
    mercado,
    probabilidade: result.probabilidade,
    confianca:     result.confianca,
  });
  if (kz.log.length > 500) kz.log = kz.log.slice(-500);

  _saveLog(kz);
}
