/**
 * funnel-live-2t.js — Funil SUPERODDS (2° Tempo, min >= 55)
 *
 * Modo SUPERODDS: identifica oportunidades de alto valor ao vivo no segundo tempo.
 * Janela de entrada: minuto >= 55 (momento de maior liquidez e previsibilidade).
 *
 * Gate triplo:
 *   • Prob     ≥ SUPERODDS_MIN_PROBABILITY  (padrão 80%)
 *   • Confiança ≥ SUPERODDS_MIN_CONFIDENCE  (padrão 80%)
 *   • Combined ≥ SUPERODDS_MIN_COMBINED     (padrão 64)
 *
 * Somente recomendação APOSTAR — CONSIDERAR é rejeitado.
 * Requer stats ao vivo (sem stats → análise bloqueada).
 *
 * Agentes ativos: BTTSAgent · GoalsAgent · CornersAgent · DoubleChanceAgent
 * Fonte de dados: SofaScore (live stats) + forma/H2H histórico
 */

import chalk from 'chalk';
import { getLiveMatches, collectLiveMatchData } from '../scrapers/sofascore.js';
import { BTTSAgent }         from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { GoalsAgent }        from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { CornersAgent }      from '../../squads/betting-analysis/market-agents/CornersAgent.js';
import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { saveLiveOpportunity } from '../utils/obsidian.js';
import { checkSuperbetLiveEligibility } from '../scrapers/superbet.js';
import { lookupMatchUrl } from '../scrapers/superbet-cache.js';
import { bttsKillSwitch, bttsMinProbability, trackBttsDecision, BTTS_MIN_CONFIDENCE } from '../utils/btts-sniper.js';
import { goalsKillSwitch, goalsMinProbability, trackGoalsDecision, GOALS_MIN_CONFIDENCE } from '../utils/goals-sniper.js';

const MIN_PROBABILITY = parseInt(process.env.SUPERODDS_MIN_PROBABILITY || '80');
const MIN_CONFIDENCE  = parseInt(process.env.SUPERODDS_MIN_CONFIDENCE  || '80');
const MIN_COMBINED    = parseInt(process.env.SUPERODDS_MIN_COMBINED    || '64');
const MAX_MATCHES     = parseInt(process.env.SUPERODDS_MAX_MATCHES     || '5');
const MATCH_DELAY_MS  = 10_000; // 10s entre análises — respeita 30 RPM Groq

// ── Agentes de mercado (4 especializados) ────────────────────────────────────
const AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
  new DoubleChanceAgent(),
];

// ── Entrada principal ─────────────────────────────────────────────────────────
/**
 * Executa um scan SUPERODDS em jogos no 2° Tempo (min >= 55).
 *
 * @param {Map} notifiedKeys — Map de chaves já notificadas (key → timestamp)
 * @returns {Array} oportunidades encontradas e aprovadas
 */
export async function runLive2TFunnel(notifiedKeys = new Map()) {
  const allLive = await getLiveMatches();
  if (!allLive.length) {
    console.log(chalk.gray('  [SUPERODDS] Nenhum jogo ao vivo'));
    return [];
  }

  // Filtra competições elegíveis na Superbet
  const liveFiltrado = allLive.filter((m) => {
    const { allowed, reason } = checkSuperbetLiveEligibility(m.home_team, m.away_team, m.competition);
    if (!allowed) {
      console.log(chalk.gray(`  ⛔ [SUPERODDS] ${m.home_team} vs ${m.away_team} — ${reason}`));
    }
    return allowed;
  });

  if (liveFiltrado.length < allLive.length) {
    console.log(chalk.gray(`  [SUPERODDS] Superbet: ${liveFiltrado.length}/${allLive.length} jogos elegíveis`));
  }

  // Filtra apenas 2° Tempo com minuto >= 55 (janela de alta liquidez)
  const segundoTempo = liveFiltrado.filter((m) => {
    const min    = m.minute ?? 0;
    const period = (m.period || '').toLowerCase();
    const is2T   = period.includes('2nd') || period.includes('second') || min >= 55;
    return is2T && !period.includes('halftime') && min >= 55;
  });

  if (!segundoTempo.length) {
    console.log(chalk.gray('  [SUPERODDS] Nenhum jogo no 2T (≥55min) disponível na Superbet'));
    return [];
  }

  const limited = segundoTempo.slice(0, MAX_MATCHES);
  console.log(chalk.bold.yellow(`  [SUPERODDS] 🟡 ${segundoTempo.length} jogo(s) min>=55 → analisando ${limited.length}`));

  for (const m of limited) {
    const min   = m.minute != null ? `${m.minute}'` : '?';
    const score = `${m.score_home}-${m.score_away}`;
    console.log(chalk.gray(`    ⚽  [${min}] ${m.home_team} vs ${m.away_team}  (${score})`));
  }

  const allOpportunities = [];

  for (let i = 0; i < limited.length; i++) {
    const match = limited[i];

    try {
      const opps = await _analyzeMatch(match, notifiedKeys);
      if (opps.length) {
        allOpportunities.push(...opps);
        console.log(chalk.bold.green(`    ✅ [SUPERODDS] ${match.home_team} vs ${match.away_team}: ${opps.length} oportunidade(s)`));
        for (const o of opps) {
          console.log(chalk.green(`       • ${o.mercado}  ${o.probabilidade}%  ${o.recomendacao}`));
        }
      } else {
        console.log(chalk.gray(`    ⏭  [SUPERODDS] ${match.home_team} vs ${match.away_team}: sem oportunidades`));
      }
    } catch (err) {
      console.error(chalk.red(`    ❌ [SUPERODDS] ${match.home_team}: ${err.message}`));
    }

    if (i < limited.length - 1) await sleep(MATCH_DELAY_MS);
  }

  return allOpportunities;
}

// ── Análise individual ────────────────────────────────────────────────────────
async function _analyzeMatch(match, notifiedKeys) {
  const liveData = await collectLiveMatchData(match);

  const temStats = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
  const temForma = !!(liveData.home?.form && liveData.home.form.length >= 3);
  const temH2H   = Array.isArray(liveData.h2h) && liveData.h2h.length >= 2;

  if (!temStats) {
    console.log(chalk.gray(`    ⏭  [SUPERODDS] ${liveData.match}: sem stats ao vivo — bloqueado`));
    return [];
  }
  if (!temForma && !temH2H) {
    console.log(chalk.gray(`    ⏭  [SUPERODDS] ${liveData.match}: dados insuficientes`));
    return [];
  }

  const minuto           = typeof liveData.minuto === 'number' ? liveData.minuto : 0;
  const minutosRestantes = typeof liveData.minutos_restantes === 'number' ? liveData.minutos_restantes : 10;
  const isAcrescimo      = liveData.is_acrescimo;

  if (minutosRestantes <= 5) return [];
  if (isAcrescimo && minuto >= 97) return [];
  if (minuto < 55) return [];

  // Roda os 4 agentes em paralelo sobre o liveData
  const rawResults = await Promise.all(
    AGENTS.map((a) => a.analyze(liveData).catch(() => []))
  );
  const allResults = rawResults.flat();

  // Gate triplo + kill switches
  const approved = allResults.filter((r) => _applyGates(r, liveData));

  if (!approved.length) return [];

  // Dedup: chave = times + mercado + placar (muda a cada gol marcado)
  const matchKey = `${match.home_team}_${match.away_team}`;
  const novos = approved.filter((r) => {
    const key = `superodds_${matchKey}_${r.mercado}_${liveData.placar}`;
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, Date.now());
    return true;
  });

  if (novos.length) {
    saveLiveOpportunity(liveData, novos, 'superodds-2t');
  }

  // Enriquece com URL direta da Superbet
  if (!liveData.superbet_url) {
    liveData.superbet_url =
      lookupMatchUrl(liveData.home?.team || match.home_team, liveData.away?.team || match.away_team, 'live') ||
      lookupMatchUrl(liveData.home?.team || match.home_team, liveData.away?.team || match.away_team, 'prelive');
  }

  return novos.map((r) => ({ ...r, _liveData: liveData }));
}

// ── Gate triplo + Kill Switches ───────────────────────────────────────────────
/**
 * Aplica o gate triplo (prob × confiança × combined) e os kill switches.
 *
 * Métrica **combined**:
 *   combined = (probabilidade × confiança) / 100
 *
 *   Raciocínio: prob e confiança separadas não impedem casos extremos como
 *   prob=95%/conf=67% que passa os gates individuais mas indica predição frágil.
 *   O produto normalizado exige que ambas sejam simultaneamente altas.
 *
 *   Threshold 64 = 80² / 100 — o mínimo possível quando prob=80 e conf=80
 *   (o valor de gate individual padrão). Qualquer par (p,c) em que um deles
 *   caia abaixo de 80 enquanto o outro permanece em 80 resulta em combined < 64,
 *   garantindo rejeição automática:
 *     prob=80, conf=79 → combined = 63.2 → BLOQUEADO
 *     prob=80, conf=80 → combined = 64.0 → PASSE mínimo
 *     prob=85, conf=80 → combined = 68.0 → APROVADO
 *
 * @param {object} r       - resultado do agente { probabilidade, confianca, mercado, recomendacao }
 * @param {object} liveData - dados ao vivo da partida
 * @returns {boolean} true = aprovado, false = bloqueado
 */
function _applyGates(r, liveData) {
  const prob     = r.probabilidade ?? 0;
  const conf     = r.confianca     ?? 0;

  /**
   * Calcula o score combined normalizado.
   * @param {number} p - probabilidade (0–100)
   * @param {number} c - confiança (0–100)
   * @returns {number} produto normalizado (0–100)
   */
  const calcCombined = (p, c) => (p * c) / 100;
  const combined = calcCombined(prob, conf);

  if (prob    < MIN_PROBABILITY)       return false;
  if (conf    < MIN_CONFIDENCE)        return false;
  if (combined < MIN_COMBINED)         return false;
  if (r.recomendacao !== 'APOSTAR')    return false;

  const mkt = (r.mercado || r.market || '').trim();

  // BTTS Sniper v3
  if (mkt === 'BTTS' || mkt === 'Ambas Marcam') {
    const killReason = bttsKillSwitch(r, liveData);
    if (killReason) {
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${killReason}`));
      trackBttsDecision('blocked', r, liveData, killReason, 'superodds-2t');
      return false;
    }
    const minProb = bttsMinProbability(liveData.competition);
    if (prob < minProb) {
      const reason = `Threshold — prob ${prob}% < ${minProb}%`;
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${reason}`));
      trackBttsDecision('blocked', r, liveData, reason, 'superodds-2t');
      return false;
    }
    if (conf < BTTS_MIN_CONFIDENCE) {
      const reason = `Threshold — confiança ${conf}% < ${BTTS_MIN_CONFIDENCE}%`;
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${reason}`));
      trackBttsDecision('blocked', r, liveData, reason, 'superodds-2t');
      return false;
    }
    trackBttsDecision('fired', r, liveData, null, 'superodds-2t');
    console.log(chalk.cyan(`    🎯 [BTTS Sniper SUPERODDS] DISPARO aprovado — ${prob}%/conf ${conf}%`));
  }

  // Goals Sniper v1
  const isGoalsMkt = /^(over|under)\s*[\d.]+$/.test(mkt) &&
                     !/corner|escanteio/i.test(mkt) &&
                     !/yc/i.test(mkt);
  if (isGoalsMkt) {
    const goalsBlock = goalsKillSwitch(r, liveData);
    if (goalsBlock) {
      console.log(chalk.gray(`    🚫 [Goals Sniper SUPERODDS] ${goalsBlock}`));
      trackGoalsDecision('blocked', r, liveData, goalsBlock, 'superodds-2t');
      return false;
    }
    const minProbGoals = goalsMinProbability(mkt, liveData.competition);
    if (prob < minProbGoals) {
      const reason = `Threshold — prob ${prob}% < ${minProbGoals}%`;
      console.log(chalk.gray(`    🚫 [Goals Sniper SUPERODDS] ${reason}`));
      trackGoalsDecision('blocked', r, liveData, reason, 'superodds-2t');
      return false;
    }
    if (conf < GOALS_MIN_CONFIDENCE) {
      const reason = `Threshold — confiança ${conf}% < ${GOALS_MIN_CONFIDENCE}%`;
      console.log(chalk.gray(`    🚫 [Goals Sniper SUPERODDS] ${reason}`));
      trackGoalsDecision('blocked', r, liveData, reason, 'superodds-2t');
      return false;
    }
    trackGoalsDecision('fired', r, liveData, null, 'superodds-2t');
    console.log(chalk.cyan(`    🎯 [Goals Sniper SUPERODDS] DISPARO aprovado — ${mkt} ${prob}%/conf ${conf}%`));
  }

  return true;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
