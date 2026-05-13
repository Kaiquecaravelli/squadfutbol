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
 * Under markets têm floor ELEVADO para 80% (gate v3, 2026-04-16):
 *   Gate duplo obrigatório: probabilidade Poisson ≥ 80% E confiança ≥ 80%.
 *   O piso de 80% é absoluto e inviolável — nenhuma liga ou contexto o reduz.
 *
 * BTTS: floor 65% (2026-05-13) — Precisão histórica BTTS é ~62%, próximo ao floor.
 *   Trava lógica adicional: se prob 60-65%, requer:
 *     - Ambos os times com média >1.0 gol/jogo OU
 *     - Competition com histórico BTTS >65%
 *   Isso evita ~38% de falsos positivos na zona cinzenta 60-65%.
 *
 * Floor Under: 80% (piso absoluto — gate v3).
 * Floor BTTS: 65% (protegido com trava lógica).
 * Floor padrão para Over/Corners: 70% (calibrado em 880+ amostras).
 *
 * @param {string} market      — mercado ('Over 2.5', 'Under 1.5', 'Over Corners 6.5', etc.)
 * @param {string} competition — nome da competição (case-insensitive)
 * @returns {number}           — floor em % (60–80)
 */
export function getKillZoneFloor(market = '', competition = '') {
  const mkt = (market || '').trim();

  // Under markets: piso absoluto 80% (gate v3, 2026-04-16)
  // Dupla condição obrigatória: prob ≥ 80% E confiança ≥ 80%.
  if (/^under\s*[\d.]+$/i.test(mkt)) return 80;

  // BTTS: floor 65% (2026-05-13) — com trava lógica adicional
  if (/^btts$/i.test(mkt) || /^ambas\s*marcam$/i.test(mkt)) return 65;

  // Calibração per-liga (Over/Corners — aguarda n≥50 na faixa 65-70%)
  const key  = `${competition.toLowerCase()}:${market}`;
  const floor = CALIBRATED_KZ_FLOORS[key];
  if (typeof floor === 'number') {
    return Math.max(65, Math.min(floor, KILL_ZONE_THRESHOLD)); // clamp [65, 70]
  }
  return KILL_ZONE_THRESHOLD; // padrão: 70
}

/**
 * Verifica se BTTS na faixa cinzenta (60-65%) deve ser bloqueado por segurança.
 * Requer que ambos os times marquem >1.0 gol/jogo OU competição com BTTS >65%.
 *
 * @param {number} prob         — probabilidade BTTS (60-65)
 * @param {object} matchData    — { xg_home, xg_away, competition }
 * @returns {boolean}           — true se deve BLOQUEAR (zona de risco)
 */
export function shouldBlockBTTSTradeZone(prob, matchData) {
  if (prob >= 65) return false; // Acima do floor — não bloquear

  const comp = (matchData?.competition || '').toLowerCase();
  const xgHome = matchData?.xg_home ?? 0;
  const xgAway = matchData?.xg_away ?? 0;

  // Liga com alta taxa BTTS (override): não bloquear
  const highBTTSLeagues = ['laliga', 'serie a', 'premier league', 'bundesliga', 'eredivisie', 'ligue 1'];
  if (highBTTSLeagues.some(l => comp.includes(l))) return false;

  // Ambos os times com ataque >1.0 gol/partida: não bloquear (condição atendida)
  if (xgHome > 1.0 && xgAway > 1.0) return false;

  // Caso contrário: bloquear (zona de risco sem condições favoráveis)
  return true;
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
