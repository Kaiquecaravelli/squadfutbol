/**
 * Funil PRÉ-LIVE — Análise de jogos pré-jogo (próximas 24h)
 *
 * Mercados: BTTS · Gols · Escanteios · Cartões · Dupla Chance · Placar Exato
 * Gate: Prob ≥ 80% E Confiança ≥ 75% E recomendação APOSTAR/CONSIDERAR
 *
 * Este funil encapsula toda a lógica de análise pré-jogo anteriormente
 * inline em auto-monitor.js, expondo uma interface uniforme:
 *   run(matches) → Array de { matchData, enriched, sentResults, matchId, idx, kickoffTime }
 */

import chalk from 'chalk';

import { BTTSAgent }         from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { GoalsAgent }        from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { CornersAgent }      from '../../squads/betting-analysis/market-agents/CornersAgent.js';
// DoubleChanceAgent DESATIVADO em 2026-04-15 — precisão global 45,4% · Away Win 29% · Draw 25% · CAINDO
// Reativação: min 50 amostras em shadow mode com precisão ≥ 80%
// import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { aggregateMatchData } from '../scrapers/aggregator.js';
import { saveMatchScan } from '../utils/obsidian.js';
import { getAgentCalibration } from '../pie/pie-storage.js';
import { bttsKillSwitch, bttsMinProbability, trackBttsDecision, BTTS_MIN_CONFIDENCE, bttsIsDeadLeague, aplicarBonusBTTS } from '../utils/btts-sniper.js';
import { goalsKillSwitch, goalsMinProbability, goalsMinConfidence, trackGoalsDecision, GOALS_MIN_CONFIDENCE } from '../utils/goals-sniper.js';
import { cornersKillSwitch, cornersMinConfidence, trackCornersDecision, CORNERS_MIN_CONFIDENCE, cornersIsDeadLeague } from '../utils/corners-sniper.js';
import { KILL_ZONE_THRESHOLD, isKillZone, trackKillZone }                   from '../utils/kill-zone.js';
import { validarUnder }                                                      from '../analysis/gateManager.js';
import { registrarUnderBloqueado }                                           from '../data/underBlockedTracker.js';

// Lazy getters — lidos em tempo de execução (não em tempo de importação do módulo)
// Permite que o protocolo de escalada (escalation-protocol.js) ajuste os gates
// via process.env antes de chamar runPreLiveSuperOdds() sem precisar reimportar.
// Kill Zone (70%) nunca é desativado — gate mínimo absoluto: 71%.
const _getMinProbability = () => Math.max(71, parseInt(process.env.PRE_LIVE_MIN_PROBABILITY || '80'));
const _getMinConfidence  = () => parseInt(process.env.PRE_LIVE_MIN_CONFIDENCE  || '75');
const _getMinOdds        = () => parseFloat(process.env.PRE_LIVE_MIN_ODDS      || '1.50');

// ── Gate dinâmico de odds baseado na calibração PIE ──────────────────────────
// Quanto maior a precisão histórica do mercado, menor a odd mínima exigida.
// Níveis: PIE ≥ 90% → aceita 1.25 | PIE ≥ 82% → 1.35 | PIE ≥ 74% → 1.45 | default → 1.50
const PIE_ODDS_TIERS = [
  { minAccuracy: 90, minProb: 85, minSamples: 50, minOdds: 1.25 },
  { minAccuracy: 82, minProb: 82, minSamples: 30, minOdds: 1.35 },
  { minAccuracy: 74, minProb: 80, minSamples: 20, minOdds: 1.45 },
];

// Cache de calibração PIE em memória por mercado — atualizado 1x por execução do funil
// FIX: cache era por objeto único (não por mercado) e a função era atribuída sem ser chamada
let _calibCache = null; // Map<market, calib>
let _calibCacheTs = 0;
const CALIB_CACHE_TTL = 5 * 60_000; // 5 min

// Cache de análises por jogo+bucket — evita repetir chamadas Groq para o mesmo jogo
// em runs consecutivos do scheduler (funil roda a cada 30min; mesmo jogo aparece 4-6x)
const _analysisCache = new Map(); // key → { result, ts }
const ANALYSIS_CACHE_TTL = 25 * 60_000; // 25 min (< intervalo do scheduler de 30min)

function _getCalibCached(market) {
  if (!_calibCache || Date.now() - _calibCacheTs >= CALIB_CACHE_TTL) {
    _calibCache = new Map();
    _calibCacheTs = Date.now();
  }
  if (!_calibCache.has(market)) {
    try { _calibCache.set(market, getAgentCalibration(market)); }
    catch { _calibCache.set(market, null); }
  }
  return _calibCache.get(market) ?? null;
}

function _getDynamicMinOdds(market, probability) {
  try {
    const calib = _getCalibCached(market);
    if (!calib) return _getMinOdds();

    const accuracy = parseFloat(calib.overall);
    const samples  = calib.samples ?? 0;

    for (const tier of PIE_ODDS_TIERS) {
      if (accuracy >= tier.minAccuracy && probability >= tier.minProb && samples >= tier.minSamples) {
        return tier.minOdds;
      }
    }
  } catch { /* PIE indisponível → usa padrão */ }
  return _getMinOdds();
}
// Delay entre jogos — calculado para 6 chaves Groq em pool:
// 3 agentes × ~1800 tokens = ~5400 tokens/jogo | pool 6 chaves × 20k TPM = 120k TPM
// Consumo em 2.5s: 5400 tokens / 2.5s = 2160 tokens/s < 2000 tokens/s/chave mas pool distribui
// Reduzido de 10s → 2.5s em 2026-04-16 (Auditoria M5 · pool de 6 chaves torna 10s obsoleto)
const MATCH_DELAY_MS  = 2_500;

// AGENTES ATIVOS (3 de elite) — corte cirúrgico 2026-04-15
// Cortado: DoubleChanceAgent (45,4% global · CAINDO · sem Fire Zone viável)
const AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
];


/**
 * Analisa uma lista de partidas pré-jogo.
 * @param {Array}  matches     — lista bruta da grade (aggregateUpcomingMatches)
 * @param {Map}    notifiedKeys — Map de chaves já notificadas (key → timestamp)
 * @returns {Array} — apenas jogos com oportunidades aprovadas
 */
export async function runPreLiveFunnel(matches, notifiedKeys = new Map()) {
  if (!matches.length) return [];

  // Invalida cache PIE a cada run do funil — garante calibração fresca
  _calibCache = null;
  _calibCacheTs = 0;

  const approved = [];
  let consecutiveErrors = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];

    try {
      const result = await _analyzeMatch(match, i, notifiedKeys);
      consecutiveErrors = 0;
      if (result) approved.push(result);
    } catch (err) {
      consecutiveErrors++;
      console.error(chalk.red(`  [PRÉ-LIVE] ❌ ${match.match || match.home_team}: ${err.message}`));

      // 3 erros consecutivos = para o ciclo, tentará no próximo agendamento
      if (consecutiveErrors >= 3) {
        console.log(chalk.yellow(`  [PRÉ-LIVE] ⏸ 3 erros consecutivos — aguardando próximo ciclo`));
        break;
      }
    }

    if (i < matches.length - 1) await sleep(MATCH_DELAY_MS);
  }

  return approved;
}

// ── Análise individual ─────────────────────────────────────────────────────────
async function _analyzeMatch(match, idx, notifiedKeys) {
  // Cache de análise: se o mesmo jogo+bucket foi analisado há < 25min, reutiliza resultado
  const matchId   = match.sofascore_id || match.match_id || `${match.home_team}_${match.away_team}`;
  const bucket    = match._bucket || 'default';
  const cacheKey  = `${matchId}:${bucket}`;
  const cached    = _analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ANALYSIS_CACHE_TTL) {
    console.log(chalk.gray(`  ♻️  [Cache] ${match.home_team} vs ${match.away_team} [${bucket}] — reutilizando análise (${Math.round((Date.now() - cached.ts) / 60_000)}min atrás)`));
    return cached.result;
  }

  const matchData = await aggregateMatchData(match);
  // Propaga campos de orquestração que aggregateMatchData não copia automaticamente
  if (match._bucket) matchData._bucket = match._bucket;

  // Pré-filtro por liga morta: elimina agentes cujos Kill Switches KS1/KS2 depende
  // apenas do nome da competição — evita ~1.390 tokens por chamada bloqueada.
  // O Kill Switch continua ativo em _applyGates() como segunda linha de defesa.
  const comp = matchData.competition || match.competition || '';
  const agentsToRun = AGENTS.filter((agent) => {
    if (agent.name === 'BTTS' && bttsIsDeadLeague(comp)) {
      console.log(chalk.gray(`    ⏭ [Pre-filter BTTS] ${comp} — liga morta`));
      return false;
    }
    if (agent.name === 'Escanteios' && cornersIsDeadLeague(comp)) {
      console.log(chalk.gray(`    ⏭ [Pre-filter Corners] ${comp} — liga morta`));
      return false;
    }
    return true;
  });

  // Módulo 4 — Anti-silence: loga quais agentes serão invocados para este jogo
  const goalsInvoked = agentsToRun.some((ag) => ag.name === 'Gols');
  if (goalsInvoked) {
    const compTag = matchData.competition ? ` [${matchData.competition}]` : '';
    console.log(chalk.cyan(`    ═══ [GoalsAgent] INVOCADO${compTag} — ${matchData.match || ''} ═══`));
  }

  // Pool Groq com 6 chaves: agentes elegíveis em paralelo com round-robin automático
  const rawResults = await Promise.allSettled(
    agentsToRun.map((agent) => agent.analyze(matchData))
  );

  // Alerta explícito para agentes que falharam (silêncio anterior mascarava falhas de rede/rate limit)
  rawResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(chalk.yellow(`  ⚠️  [Agente falhou] ${agentsToRun[i]?.name || `agente[${i}]`}: ${r.reason?.message || r.reason}`));
    }
  });

  const allResults = rawResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  // Módulo 4 — Anti-silence logging: registra o que cada agente retornou
  // Essencial para diagnosticar falhas silenciosas (ex: GoalsAgent retornando 0%)
  allResults.forEach((r) => {
    if (r.agent === 'Gols') {
      const mkt  = r.mercado || r.market || '?';
      const prob = r.probabilidade ?? '?';
      const conf = r.confianca ?? '?';
      const rec  = r.recomendacao || '?';
      const extra = r._skippedGemini ? ' [Quant direto]' : '';
      console.log(chalk.cyan(`    ℹ️  [GoalsAgent] → ${mkt} | prob ${prob}% | conf ${conf}% | ${rec}${extra}`));
    }
  });

  if (!allResults.length) return null;

  // Enriquece com metadados — filtro + dedup
  const matchKey = `${match.home_team || matchData.home?.team}_${match.away_team || matchData.away?.team}`;

  // Salva TODOS os resultados no Obsidian (antes do filtro de gate)
  const approvedForObsidian = allResults.filter((r) =>
    (r?.probabilidade ?? 0) >= _getMinProbability() && (r?.confianca ?? 0) >= _getMinConfidence()
  );
  saveMatchScan(matchData, allResults, approvedForObsidian);

  // Whitelist de mercados válidos na Superbet — qualquer mercado fora dessa lista
  // é bloqueado imediatamente (previne hallucinations do LLM como "Under 8.5 Gols")
  const VALID_MARKETS = new Set([
    // Gols
    'Over 1.5', 'Over 2.5', 'Over 3.5', 'Over 4.5',
    'Under 1.5', 'Under 2.5', 'Under 3.5',
    // Escanteios — sempre com "Corners" no nome
    'Over Corners 6.5', 'Over Corners 7.5', 'Over Corners 8.5', 'Over Corners 9.5',
    'Under Corners 7.5', 'Under Corners 8.5', 'Under Corners 9.5',
    // Cartões amarelos
    'YC 2.5', 'YC 3.5', 'YC 4.5', 'Over YC 2.5', 'Over YC 3.5', 'Over YC 4.5',
    // BTTS
    'BTTS', 'Ambas Marcam',
    // Dupla chance
    '1X', 'X2', '12',
    // Resultado final
    '1', '2', 'X', 'Home Win', 'Away Win', 'Draw',
    // Placar exato — aceita qualquer formato "N-N" ou "Placar"
  ]);

  const enriched = allResults
    .filter((r) => {
      if (!r || typeof r.probabilidade !== 'number') return false;

      // ── KILL ZONE GATE UNIVERSAL ────────────────────────────────────────────
      // Prob < floor: 0% de precisão histórica (880+ amostras para Over/BTTS/Corners).
      // Floor padrão: 70% | Floor Under: 80% (gate v3, 2026-04-16 — piso absoluto inviolável).
      // Dupla condição Under: probabilidade ≥ 80% E confiança ≥ 80% (ambas obrigatórias).
      const mktKZ = r.mercado || r.market || '';
      if (isKillZone(r.probabilidade, mktKZ, matchData.competition || '')) {
        const floorKZ = (mktKZ && /^under\s*[\d.]+$/i.test(mktKZ.trim())) ? 80 : KILL_ZONE_THRESHOLD;
        console.log(chalk.red(`    ⛔ [Kill Zone] ${mktKZ} — prob ${r.probabilidade}% < ${floorKZ}% (piso absoluto)`));
        trackKillZone(r, matchData, 'prelive');
        return false;
      }

      // ── THRESHOLD MÍNIMO GLOBAL ──────────────────────────────────────────────
      // Goals markets (Over/Under X.X) têm thresholds calibrados por tier e liga
      // na Goals Sniper Gate (abaixo). Aplicar o threshold genérico 71-80% aqui
      // bloquearia Under 1.5/2.5 antes que a gate especializada possa avaliá-los.
      // → Para goals markets: skip threshold global (Goals Sniper Gate cuida).
      // → Para outros mercados (BTTS, Corners, YC): aplicar threshold global.
      const _mktGlobal = (r.mercado || r.market || '').trim();
      const _isGoalsMktGlobal = /^(over|under)\s*[\d.]+$/i.test(_mktGlobal) &&
                                !/corner|escanteio/i.test(_mktGlobal) &&
                                !/yc/i.test(_mktGlobal);
      if (!_isGoalsMktGlobal) {
        if (r.probabilidade < _getMinProbability()) return false;
        if ((r.confianca ?? 0) < _getMinConfidence()) return false;
      }
      // Normaliza campo de mercado: alguns agentes retornam 'market', outros 'mercado'
      if (!r.mercado && r.market) r.mercado = r.market;
      if (!r.market && r.mercado) r.market  = r.mercado;
      // Corrige hallucination do LLM: agente retornou "Under/Over X.5" sem "Corners"
      // Condição 1: r.market já indica escanteio (campo autoritativo)
      // Condição 2: mercado genérico com linha ≥ 5.5 (gols nunca chegam a 5.5+)
      if (r.mercado) {
        const _merc = r.mercado.trim();
        const _mkt  = (r.market || '').toLowerCase();
        const _isGenericOverUnder = /^(over|under)\s*[\d.]+$/i.test(_merc);
        const _linha = parseFloat(_merc.match(/[\d.]+/)?.[0] || '0');
        const _isEscanteioByMarket = /escanteio|corner/i.test(_mkt);
        const _isEscanteioByLinha  = _isGenericOverUnder && _linha >= 5.5; // gols não chegam a 5.5+
        if ((_isEscanteioByMarket || _isEscanteioByLinha) && _isGenericOverUnder) {
          const dir = /^under/i.test(_merc) ? 'Under' : 'Over';
          const num = _merc.match(/[\d.]+/)?.[0] || '';
          r.mercado = `${dir} Corners ${num}`;
          if (!_isEscanteioByMarket) r.market = 'Escanteios'; // corrige market ausente/errado
        }
      }
      // Whitelist positiva — apenas recomendações explícitas de aposta passam
      // Bug anterior: apenas bloqueava 'NÃO'/'AGUARDAR' → 'INCERTO' com prob 82%/conf 76% disparava
      const recom = r.recomendacao || r.recommendation || '';
      if (!['APOSTAR', 'SIM', 'CONSIDERAR'].includes(recom)) return false;
      // BTTS Sniper Gate — Kill Switches v3 (módulo btts-sniper.js compartilhado)
      const mktForBtts = (r.mercado || r.market || '').trim();
      if (mktForBtts === 'BTTS' || mktForBtts === 'Ambas Marcam') {
        // Padrões P_B1–P_B10 (calibração 19/04/2026): elevam probabilidade antes do gate
        const bonusResult = aplicarBonusBTTS(r, matchData);
        if (bonusResult.padroes_ativos.length > 0) r = { ...r, ...bonusResult.result };
        const bttsBlock = bttsKillSwitch(r, matchData);
        if (bttsBlock) {
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${bttsBlock}`));
          trackBttsDecision('blocked', r, matchData, bttsBlock, 'prelive');
          return false;
        }
        const minProb = bttsMinProbability(matchData.competition);
        if (r.probabilidade < minProb) {
          const reason = `Threshold — prob ${r.probabilidade}% < ${minProb}%`;
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${reason}`));
          trackBttsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        if ((r.confianca ?? 0) < BTTS_MIN_CONFIDENCE) {
          const reason = `Threshold — confiança ${r.confianca}% < ${BTTS_MIN_CONFIDENCE}%`;
          console.log(chalk.gray(`    🚫 [BTTS Sniper] ${reason}`));
          trackBttsDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        trackBttsDecision('fired', r, matchData, null, 'prelive');
        console.log(chalk.cyan(`    🎯 [BTTS Sniper] DISPARO aprovado — ${r.probabilidade}%/conf ${r.confianca}% (${matchData.competition || ''})`));
      }
      // Goals Sniper Gate — Kill Switches v2 (mercados Over/Under de gols)
      // Fix: regex original não capturava "Total de Gols" (nome genérico do GoalsAgent)
      const mktForGoals = (r.mercado || r.market || '').trim();
      const isGoalsMarket = (
        /^(over|under)\s*[\d.]+$/i.test(mktForGoals) ||  // "Over 1.5", "Under 2.5" (flag i — LLM retorna maiúsculo)
        /total.*gols/i.test(mktForGoals)                  // "Total de Gols" — nome genérico
      ) &&
      !/corner|escanteio/i.test(mktForGoals) &&
      !/yc/i.test(mktForGoals);
      if (isGoalsMarket) {
        const goalsBlock = goalsKillSwitch(r, matchData);
        if (goalsBlock) {
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${goalsBlock}`));
          trackGoalsDecision('blocked', r, matchData, goalsBlock, 'prelive');
          // Under: registra no tracker para monitoramento de calibração
          if (/^under\s*[\d.]+$/i.test(mktForGoals) && (r.probabilidade ?? 0) >= 62) {
            registrarUnderBloqueado(matchData, mktForGoals, r.probabilidade, r.confianca ?? 0, goalsBlock);
          }
          return false;
        }
        const minProbGoals = goalsMinProbability(mktForGoals, matchData.competition);
        if ((r.probabilidade ?? 0) < minProbGoals) {
          const reason = `Threshold — prob ${r.probabilidade}% < ${minProbGoals}%`;
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${reason}`));
          trackGoalsDecision('blocked', r, matchData, reason, 'prelive');
          if (/^under\s*[\d.]+$/i.test(mktForGoals) && (r.probabilidade ?? 0) >= 62) {
            registrarUnderBloqueado(matchData, mktForGoals, r.probabilidade, r.confianca ?? 0, reason);
          }
          return false;
        }
        // AÇÃO 2 — Fire Zone: confiança mínima por mercado (Over 2.5/3.5 exigem 80%)
        const minConfGoals = goalsMinConfidence(mktForGoals);
        if ((r.confianca ?? 0) < minConfGoals) {
          const fzTag = minConfGoals > GOALS_MIN_CONFIDENCE ? ' [Fire Zone gate]' : '';
          const reason = `Threshold — confiança ${r.confianca}% < ${minConfGoals}%${fzTag}`;
          console.log(chalk.gray(`    🚫 [Goals Sniper] ${reason}`));
          trackGoalsDecision('blocked', r, matchData, reason, 'prelive');
          // ── DUPLA VALIDAÇÃO UNDER (Módulo 2) ──────────────────────────────────
          // Under requer prob ≥ 80% E confiança ≥ 80% simultaneamente.
          // Aqui já sabemos que confiança < 80%. Registra como Under bloqueado.
          if (/^under\s*[\d.]+$/i.test(mktForGoals) && (r.probabilidade ?? 0) >= 62) {
            const vUnder = validarUnder(mktForGoals, r.probabilidade, r.confianca ?? 0,
                                        matchData.competition || '');
            if (vUnder && !vUnder.elegivel) {
              registrarUnderBloqueado(matchData, mktForGoals, r.probabilidade, r.confianca ?? 0,
                                      vUnder.motivo);
            }
          }
          return false;
        }
        // ── DUPLA VALIDAÇÃO UNDER — caso especial: prob OK mas conf na fronteira ─
        if (/^under\s*[\d.]+$/i.test(mktForGoals)) {
          const vUnder = validarUnder(mktForGoals, r.probabilidade, r.confianca ?? 0,
                                      matchData.competition || '');
          if (vUnder && !vUnder.elegivel) {
            console.log(chalk.gray(`    🚫 [Under Gate] ${vUnder.motivo}`));
            trackGoalsDecision('blocked', r, matchData, vUnder.motivo, 'prelive');
            registrarUnderBloqueado(matchData, mktForGoals, r.probabilidade, r.confianca ?? 0,
                                    vUnder.motivo);
            return false;
          }
        }
        trackGoalsDecision('fired', r, matchData, null, 'prelive');
        console.log(chalk.cyan(`    🎯 [Goals Sniper] DISPARO aprovado — ${mktForGoals} ${r.probabilidade}%/conf ${r.confianca}%`));
      }
      // Corners Sniper Gate — Liga Whitelist + Fire Zone (conf ≥ 80%) + KS1-3
      const mktForCorners = (r.mercado || r.market || '').trim();
      const isCornersMarket = /corner|escanteio/i.test(r.market || r.mercado || '');
      if (isCornersMarket) {
        const cornersBlock = cornersKillSwitch(r, matchData);
        if (cornersBlock) {
          console.log(chalk.gray(`    🚫 [Corners Sniper] ${cornersBlock}`));
          trackCornersDecision('blocked', r, matchData, cornersBlock, 'prelive');
          return false;
        }
        const minConfCorners = cornersMinConfidence(mktForCorners);
        if ((r.confianca ?? 0) < minConfCorners) {
          const reason = `Fire Zone gate — confiança ${r.confianca}% < ${minConfCorners}% [Fire Zone gate]`;
          console.log(chalk.gray(`    🚫 [Corners Sniper] ${reason}`));
          trackCornersDecision('blocked', r, matchData, reason, 'prelive');
          return false;
        }
        trackCornersDecision('fired', r, matchData, null, 'prelive');
        console.log(chalk.cyan(`    🎯 [Corners Sniper] DISPARO aprovado — ${mktForCorners} ${r.probabilidade}%/conf ${r.confianca}%`));
      }
      // Whitelist gate — bloqueia mercados inventados pelo LLM
      const mkt = (r.mercado || r.market || '').trim();
      const isExactScore = /^\d+-\d+$/.test(mkt) || /placar/i.test(mkt);
      const isDupla = /^(dupla|double)/i.test(mkt);
      const isResult = /^(resultado|result)/i.test(mkt);
      if (!isExactScore && !isDupla && !isResult && !VALID_MARKETS.has(mkt)) {
        console.log(chalk.gray(`    🚫 [Market Gate] ${mkt} bloqueado — mercado não disponível na Superbet`));
        return false;
      }
      // Gate de odds dinâmico — limiar reduzido para mercados com alta precisão PIE
      const realOdd  = _realOddForMarket(r.mercado || r.market, matchData.odds);
      const modelOdd = r.odds_minima_recomendada ?? r.odds_minima ?? null;
      const odds     = realOdd ?? modelOdd ?? 0;
      // Bloqueia análise sem nenhuma validação de odds — previne EV negativo silencioso
      if (realOdd === null && modelOdd === null) {
        console.log(chalk.gray(`    🚫 [Odds Gate] ${r.mercado || r.market} bloqueado — sem odds (real ou modelo)`));
        return false;
      }
      const minOdds  = _getDynamicMinOdds(r.mercado || r.market, r.probabilidade ?? 0);
      if (odds > 0 && odds < minOdds) {
        const pieTag = minOdds < _getMinOdds() ? ` [PIE gate: ${minOdds}]` : '';
        console.log(chalk.gray(`    🚫 [Odds Gate] ${r.mercado || r.market} bloqueado — odd ${odds} < ${minOdds}${pieTag}`));
        return false;
      }
      // Gate de sanidade para mercados de alta variância (Over 3.5 / Over 4.5)
      // Base rates históricas: Over 3.5 = 24.5% | Over 4.5 = 13.4%
      const mercadoNorm = (r.mercado || r.market || '').toLowerCase();
      if (mercadoNorm.includes('over 3.5') || mercadoNorm.includes('over_3.5')) {
        if (!realOdd) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 3.5 bloqueado — sem odd real da Superbet (base rate 24.5%)`));
          return false;
        }
        // Se odd real disponível, valida EV: só passa se prob_modelo > 1/real_odd × 100
        const impliedProb = (1 / realOdd) * 100;
        if ((r.probabilidade ?? 0) < impliedProb) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 3.5 bloqueado — prob modelo (${r.probabilidade}%) < implied (${impliedProb.toFixed(1)}%) com odd ${realOdd}`));
          return false;
        }
      }
      if (mercadoNorm.includes('over 4.5') || mercadoNorm.includes('over_4.5')) {
        if (!realOdd) {
          console.log(chalk.gray(`    🚫 [Sanity Gate] Over 4.5 bloqueado — sem odd real da Superbet (base rate 13.4%)`));
          return false;
        }
      }
      return true;
    })
    .map((r) => {
      const realOdd = _realOddForMarket(r.mercado || r.market, matchData.odds);
      const modelOdd = r.odds_minima_recomendada ?? r.odds_minima ?? null;
      // Prefere odd real da Superbet; cai para estimativa do modelo se não disponível
      const oddsMinima = realOdd ?? modelOdd;
      if (realOdd && modelOdd && realOdd !== modelOdd) {
        console.log(chalk.gray(`    📊 [Odds] ${r.mercado} — real Superbet: ${realOdd} | estimativa modelo: ${modelOdd}`));
      }
      return {
        ...r,
        probabilidade: r.probabilidade ?? r.confidence_score,
        confianca:     r.confianca     ?? r.confidence,
        odds_minima:   oddsMinima,
      };
    });

  if (!enriched.length) return null;

  // Dedup por jogo + bucket (não por mercado) — um envio por jogo por bucket
  // Quando o jogo transita para o próximo bucket (ex: +6h → +3h), nova análise disparada.
  // Chave retroativa sem bucket: pre_{id} (compatibilidade com execuções anteriores)
  const sfId      = matchData.sofascore_id || matchData.match_id || matchKey;
  const bucketKey = matchData._bucket || '';
  const gameKey   = bucketKey ? `dedup:${sfId}:${bucketKey}` : `pre_${sfId}`;

  if (notifiedKeys.has(gameKey)) return null;

  // Todos os mercados aprovados neste ciclo compõem a notificação única do jogo+bucket
  const novos = enriched;
  if (!novos.length) return null;

  // Marca o jogo como enviado neste bucket — bloqueia reenvio em varreduras futuras
  notifiedKeys.set(gameKey, Date.now());

  const result = {
    idx,
    matchData,
    enriched: novos,
    sentResults: novos,
    matchId:     matchKey,
    kickoffTime: matchData.date ? new Date(matchData.date).getTime() : null,
  };

  // Salva no cache para reutilização nos próximos runs do scheduler
  _analysisCache.set(cacheKey, { result, ts: Date.now() });

  return result;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Mapeia o nome do mercado para a chave de odds real coletada da Superbet.
 * Retorna a odd real ou null se não disponível.
 */
function _realOddForMarket(mercado, oddsObj) {
  if (!oddsObj || !mercado) return null;

  // Mapeamento explícito para escanteios — "Over/Under Corners X.X" → chave Superbet
  const mktLow = mercado.toLowerCase();
  if (mktLow.includes('corner') || mktLow.includes('escanteio')) {
    const linha = mercado.match(/[\d.]+/)?.[0] || '';
    const linhaKey = linha.replace('.', '_');
    if (/over/i.test(mercado)) {
      // over_corners_6_5, over_corners_7_5, over_corners_8_5, over_corners_9_5
      const key = `over_corners_${linhaKey}`;
      return oddsObj[key] ?? null;
    } else if (/under/i.test(mercado)) {
      // under_corners_8_5 etc — se a Superbet não tiver, retorna null (sem fallback)
      const key = `under_corners_${linhaKey}`;
      return oddsObj[key] ?? null;
    }
  }

  // YC (cartões amarelos): "YC 2.5" | "Over YC 2.5" → over_yc_2_5
  if (mktLow.includes('yc') || mktLow.includes('card') || mktLow.includes('cartao') || mktLow.includes('cartão')) {
    const linha = mercado.match(/[\d.]+/)?.[0] || '';
    const linhaKey = linha.replace('.', '_');
    const key = `over_yc_${linhaKey}`;
    return oddsObj[key] ?? null;
  }

  // Normaliza duas variantes: com ponto ("over_3.5") e sem ponto ("over_35")
  const base    = mercado.toLowerCase().replace(/\s+/g, '_');
  const withDot = base;
  const noDot   = base.replace(/\./g, '');
  for (const key of [withDot, noDot]) {
    if (oddsObj[key] != null) return oddsObj[key];
  }
  // Variantes BTTS
  if (noDot.includes('btts') || noDot.includes('ambas')) return oddsObj.btts_yes ?? null;
  // 1X2
  if (noDot === '1' || noDot.includes('home_win') || noDot.includes('vitoria_mandante') || noDot.includes('vitoria_casa') || noDot.includes('casa')) return oddsObj.home_win ?? null;
  if (noDot === '2' || noDot.includes('away_win') || noDot.includes('vitoria_visitante') || noDot.includes('vitoria_fora') || noDot.includes('fora')) return oddsObj.away_win ?? null;
  if (noDot === 'x' || noDot.includes('empate')) return oddsObj.draw ?? null;
  return null;
}
