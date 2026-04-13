/**
 * prelive-analysis.js — Modelo de Análise Pré-Live
 *
 * Janela: até 24h antes do evento
 * Odds alvo: 2x – 10x por aposta simples
 * Foco: forma, H2H, notícias, PIE calibrado, steam move pré-jogo
 *
 * Uso:
 *   import { runPreLiveAnalysis } from './prelive-analysis.js';
 *   await runPreLiveAnalysis([matchId1, matchId2], { bankroll: 1000 });
 *
 * CLI:
 *   node src/workflows/prelive-analysis.js --demo
 *   node src/workflows/prelive-analysis.js --matches="id1,id2" --bankroll=2000
 */

import { runFullMatchAnalysis } from './full-match-analysis.js';
import { notifyPreLiveAnalysis, notifyScorePredictions } from '../utils/telegram.js';
import { loadDB } from '../pie/pie-storage.js';

// Filtro de odds: pré-live foca em apostas de baixo-médio risco
const PRELIVE_ODDS_MIN = 1.30;   // floor: abaixo disso não há valor
const PRELIVE_ODDS_MAX = 10.0;   // ceiling: acima vira parlay
const PRELIVE_CONF_MIN = 68;     // confiança mínima para notificar

/**
 * Calcula o retorno potencial de forma clara para o Telegram.
 */
export function calcRetornoPotencial(odds, bankroll, stakePct) {
  const stake  = Math.round(bankroll * (stakePct / 100) * 100) / 100;
  const ganho  = Math.round(stake * odds * 100) / 100;
  const roi    = Math.round((odds - 1) * 100);
  return { stake, ganho, roi };
}

/**
 * Determina o nível de risco para exibição no Telegram.
 */
export function calcRiscoDisplay(confidence, odds, mode = 'prelive') {
  if (mode === 'live') {
    // Ao vivo: mais conservador pois odds são dinâmicas
    if (confidence >= 85 && odds <= 2.0) return { label: 'Baixo',  icon: '🟢', desc: 'odds estáveis + alta confiança' };
    if (confidence >= 78)                return { label: 'Médio',  icon: '🟡', desc: 'odds ao vivo — monitore saída' };
    return                                      { label: 'Alto',   icon: '🔴', desc: 'ao vivo — alta volatilidade' };
  }
  // Pré-live
  if (confidence >= 80 && odds <= 3.0)   return { label: 'Baixo',  icon: '🟢', desc: 'seleção bem fundamentada' };
  if (confidence >= 72 || odds <= 5.0)   return { label: 'Médio',  icon: '🟡', desc: '' };
  return                                         { label: 'Alto',   icon: '🔴', desc: 'especulativo — stake reduzida' };
}

/**
 * Filtra análises qualificadas para o modelo pré-live.
 */
function filterPreLiveResults(analyses) {
  return analyses.filter(a => {
    if (!a || !a.top_bet) return false;
    const score  = a.confidence_score ?? 0;
    const odds   = a.top_bet?.odds ?? 0;
    const action = a.recommendation?.action;
    return (
      (action === 'BET' || action === 'CONSIDER') &&
      score  >= PRELIVE_CONF_MIN &&
      odds   >= PRELIVE_ODDS_MIN &&
      odds   <= PRELIVE_ODDS_MAX
    );
  });
}

/**
 * Pipeline principal de análise pré-live.
 * @param {string[]} matchIds - IDs das partidas (até 24h antes)
 * @param {object}   options
 * @param {number}   options.bankroll    - Banca total (default env ou 1000)
 * @param {boolean}  options.demo        - Usar mock data
 * @param {boolean}  options.notify      - Enviar ao Telegram (default true)
 */
export async function runPreLiveAnalysis(matchIds, options = {}) {
  const bankroll = options.bankroll || parseFloat(process.env.USER_BANKROLL || '1000');
  const isDemo   = options.demo || process.env.DEMO_MODE === 'true';
  const notify   = options.notify !== false;

  console.log('\n' + '═'.repeat(64));
  console.log(`  🔵 PRÉ-LIVE — Análise até 24h antes do evento`);
  console.log(`  Partidas: ${matchIds.length} | Banca: R$ ${bankroll} | ${isDemo ? 'DEMO' : 'REAL'}`);
  console.log('═'.repeat(64) + '\n');

  // Roda pipeline completo em paralelo para cada jogo
  const settled = await Promise.allSettled(
    matchIds.map(id => runFullMatchAnalysis(id, { bankroll, demo: isDemo }))
  );

  const allResults = settled
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  // Filtra os qualificados para o modelo pré-live
  const qualified = filterPreLiveResults(allResults);

  console.log(`\n📊 Resultados: ${allResults.length} analisados | ${qualified.length} qualificados para Pré-Live\n`);

  if (qualified.length === 0) {
    console.log('  ⚠️  Nenhuma oportunidade pré-live com critérios mínimos.');
    return { total: allResults.length, qualified: 0, sent: 0 };
  }

  // Carrega PIE para exibir acurácia histórica do mercado
  let db;
  try { db = loadDB(); } catch { db = null; }

  let sent = 0;
  for (const analysis of qualified) {
    const topBet    = analysis.top_bet;
    const score     = analysis.confidence_score;
    const risco     = calcRiscoDisplay(score, topBet.odds, 'prelive');
    const stakeInfo = calcRetornoPotencial(
      topBet.odds,
      bankroll,
      analysis.risk?.stake_pct || (risco.label === 'Baixo' ? 5 : risco.label === 'Médio' ? 3 : 1.5)
    );

    // Acurácia PIE para o mercado
    const pieKey     = topBet.market;
    const pieCal     = db?.calibration?.[pieKey];
    const pieAccuracy = pieCal?.total >= 10
      ? Math.round((pieCal.hits / pieCal.total) * 100)
      : null;

    // Tempo até o jogo
    const matchDate = analysis.matchData?.date;
    const horasAte  = matchDate
      ? Math.max(0, Math.round((new Date(matchDate) - Date.now()) / 3_600_000))
      : null;

    console.log(`  🔵 ${(analysis.matchData?.match || analysis.match_name || 'Jogo').substring(0, 40)}`);
    console.log(`     Mercado: ${topBet.market} @ ${topBet.odds} | Conf: ${score}/100 | EV: ${topBet.ev_pct || 'N/A'}`);
    console.log(`     Stake R$ ${stakeInfo.stake} → Ganho R$ ${stakeInfo.ganho} (+${stakeInfo.roi}%) | ${risco.icon} ${risco.label}`);
    console.log();

    if (notify) {
      await notifyPreLiveAnalysis(analysis, {
        stakeInfo,
        risco,
        pieAccuracy,
        horasAte,
        bankroll,
      }).catch(e => console.warn(`  ⚠️ Telegram falhou: ${e.message}`));

      // Ariel: enviar análise de placar exato se houver value
      const sp = analysis.score_prediction;
      if (sp) {
        const hasValue = sp.exact_scores?.value_bets?.length > 0 || sp.double_chance_bets?.value_bets?.length > 0;
        if (hasValue) {
          await notifyScorePredictions(sp, analysis.matchData || {}).catch(() => {});
        }
      }

      sent++;
    }
  }

  return { total: allResults.length, qualified: qualified.length, sent };
}

// ── CLI direto ────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('prelive-analysis.js')) {
  import('dotenv/config').catch(() => {});

  const args      = process.argv.slice(2);
  const demo      = args.includes('--demo');
  const matchArg  = args.find(a => a.startsWith('--matches='));
  const bankArg   = args.find(a => a.startsWith('--bankroll='));

  const matchIds = matchArg
    ? matchArg.split('=')[1].split(',').map(s => s.trim())
    : ['demo-1', 'demo-2', 'demo-3'];

  const bankroll = bankArg ? parseFloat(bankArg.split('=')[1]) : 1000;

  await runPreLiveAnalysis(matchIds, { bankroll, demo: demo || !matchArg });
}
