/**
 * live-scan.js — Scan SUPERODDS In-Play (jogos em andamento)
 *
 * Fluxo:
 *  1. Busca todos os jogos ao vivo via SofaScore
 *  2. Para cada jogo: coleta stats em tempo real (xG, posse, chutes, ataques)
 *  3. Roda 4 agentes Groq em paralelo (BTTS · Goals · Corners · DoubleChance)
 *  4. Filtra: prob >= 80% E confiança >= 80% E combined >= 64 E recomendação APOSTAR
 *  5. Envia alertas individuais via Telegram
 *  6. Loop opcional: re-escaneia a cada N minutos
 *
 * Provider: Groq (llama-3.1-8b-instant) via BaseMarketAgent + callGroqWithRotation
 * Rate limit: 30 RPM por chave × 6 chaves = 180 RPM total
 *
 * Uso:
 *   node src/index.js superodds                      → scan único agora
 *   node src/index.js superodds --loop               → loop contínuo (15 min)
 *   node src/index.js superodds --loop --interval=5  → loop a cada 5 min
 *   node src/index.js superodds --max=10             → limitar a 10 jogos
 */

import chalk from 'chalk';
import { getLiveMatches, collectLiveMatchData } from '../scrapers/sofascore.js';
import { BTTSAgent }         from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { GoalsAgent }        from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { CornersAgent }      from '../../squads/betting-analysis/market-agents/CornersAgent.js';
import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { notifyLiveOpportunity } from '../utils/telegram.js';
import { saveLiveOpportunity } from '../utils/obsidian.js';
import { checkSuperbetLiveEligibility } from '../scrapers/superbet.js';
import { lookupMatchUrl } from '../scrapers/superbet-cache.js';
import { bttsKillSwitch, bttsMinProbability, trackBttsDecision, BTTS_MIN_CONFIDENCE } from '../utils/btts-sniper.js';
import { goalsKillSwitch, goalsMinProbability, trackGoalsDecision, GOALS_MIN_CONFIDENCE } from '../utils/goals-sniper.js';

const MIN_PROBABILITY      = parseInt(process.env.SUPERODDS_MIN_PROBABILITY        || '80');
const MIN_CONFIDENCE       = parseInt(process.env.SUPERODDS_MIN_CONFIDENCE         || '80');
const MIN_COMBINED         = parseInt(process.env.SUPERODDS_MIN_COMBINED           || '64');
const DEFAULT_INTERVAL_MIN = parseInt(process.env.SUPERODDS_SCAN_INTERVAL_MINUTES  || '15');
const MAX_MATCHES          = parseInt(process.env.SUPERODDS_MAX_MATCHES            || '4');
const MATCH_DELAY_MS       = 10_000; // 10s entre análises — respeita 30 RPM Groq

// ── Instâncias dos 4 agentes ativos ──────────────────────────────────────────
const AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
  new DoubleChanceAgent(),
];

// ── Entrada principal ─────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {boolean} opts.loop             — ativa loop contínuo
 * @param {number}  opts.intervalMin      — intervalo do loop em minutos
 * @param {number}  opts.maxMatches       — número máximo de jogos por scan
 * @param {Map}     opts.sharedNotifiedKeys — Map compartilhado para dedup entre funnels
 */
export async function startLiveScan({
  loop = false,
  intervalMin = DEFAULT_INTERVAL_MIN,
  maxMatches  = MAX_MATCHES,
  sharedNotifiedKeys,
} = {}) {
  _printBanner(loop, intervalMin);

  await runLiveScan(maxMatches, sharedNotifiedKeys);

  if (!loop) return;

  console.log(chalk.gray(`\n⏰ Próximo scan SUPERODDS em ${intervalMin} minuto(s)...\n`));

  const intervalMs = intervalMin * 60_000;
  setInterval(async () => {
    await runLiveScan(maxMatches, sharedNotifiedKeys).catch((err) => {
      console.error(chalk.red(`[SUPERODDS Scan] Erro no loop: ${err.message}`));
    });
    console.log(chalk.gray(`\n⏰ Próximo scan SUPERODDS em ${intervalMin} minuto(s)...\n`));
  }, intervalMs);

  await new Promise(() => {});
}

// ── Ciclo de scan ─────────────────────────────────────────────────────────────
async function runLiveScan(maxMatches, sharedNotifiedKeys) {
  const start = Date.now();
  const ts    = timestamp();

  console.log(chalk.bold.magenta(`\n[${ts}] 🔮 Iniciando scan SUPERODDS...`));

  // 1. Buscar jogos em andamento
  const liveMatches = await getLiveMatches();

  if (!liveMatches.length) {
    console.log(chalk.yellow('  ⚠️  Nenhum jogo ao vivo encontrado.'));
    return;
  }

  // 2. Filtrar competições disponíveis na Superbet
  const available = liveMatches.filter((m) => {
    const { allowed, reason } = checkSuperbetLiveEligibility(m.home_team, m.away_team, m.competition);
    if (!allowed) {
      console.log(chalk.gray(`  ⛔ [Superbet] ${m.home_team} vs ${m.away_team} — ${reason}`));
    }
    return allowed;
  });

  if (!available.length) {
    console.log(chalk.yellow('  ⚠️  Nenhum jogo disponível na Superbet.'));
    return;
  }

  const limited = available.slice(0, maxMatches);
  console.log(chalk.white(`  📡 ${liveMatches.length} ao vivo → ${available.length} na Superbet → analisando ${limited.length}`));

  for (const m of limited) {
    const score = `${m.score_home}-${m.score_away}`;
    const min   = m.minute != null ? `${m.minute}'` : (m.period || '?');
    console.log(chalk.gray(`    ⚽  [${min}] ${m.home_team} vs ${m.away_team}  (${score})  —  ${m.competition || '?'}`));
  }

  // 3. Analisar cada jogo com os 4 agentes
  let totalOpportunidades = 0;

  for (let i = 0; i < limited.length; i++) {
    const match = limited[i];
    const label = `${match.home_team} vs ${match.away_team}`;
    const score = `${match.score_home}-${match.score_away}`;
    const min   = match.minute != null ? `${match.minute}'` : '?';

    console.log(chalk.bold.white(`\n  🔮 [${i + 1}/${limited.length}] ${label}  [${min}]  ${score}`));

    try {
      const opportunities = await analyzeMatch(match, sharedNotifiedKeys);

      if (opportunities.length) {
        totalOpportunidades += opportunities.length;
        console.log(chalk.bold.green(`    ✅ ${opportunities.length} oportunidade(s):`));
        for (const o of opportunities) {
          console.log(chalk.green(`       • ${o.mercado}  ${o.probabilidade}%  ${o.recomendacao}`));
        }
        if (!match._liveData.superbet_url) {
          match._liveData.superbet_url =
            lookupMatchUrl(match.home_team, match.away_team, 'live') ||
            lookupMatchUrl(match.home_team, match.away_team, 'prelive');
        }
        await notifyLiveOpportunity(match._liveData, opportunities).catch(() => {});
      } else {
        console.log(chalk.gray('    ⏭  Sem oportunidades (critérios não atingidos)'));
      }
    } catch (err) {
      console.error(chalk.red(`    ❌ Erro: ${err.message}`));
    }

    if (i < limited.length - 1) await sleep(MATCH_DELAY_MS);
  }

  const elapsed = Date.now() - start;
  console.log(chalk.bold.magenta(`\n[${timestamp()}] 🔮 Scan SUPERODDS concluído · ${totalOpportunidades} oportunidade(s) · ${Math.round(elapsed / 1000)}s`));
}

// ── Análise individual de um jogo ─────────────────────────────────────────────
async function analyzeMatch(match, sharedNotifiedKeys) {
  const liveData = await collectLiveMatchData(match);
  match._liveData = liveData;

  const temStats  = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
  const temForma  = !!(liveData.home?.form && liveData.home.form !== 'N/A' && liveData.home.form.length >= 3);
  const temH2H    = Array.isArray(liveData.h2h) && liveData.h2h.length >= 2;

  if (!temStats && !temForma && !temH2H) {
    console.log(chalk.gray('    ⏭  Dados insuficientes (sem stats, forma ou H2H)'));
    return [];
  }

  if (!temStats) {
    console.log(chalk.gray('    ⏭  Sem stats ao vivo — análise SUPERODDS bloqueada'));
    return [];
  }

  const minuto           = typeof liveData.minuto === 'number' ? liveData.minuto : 0;
  const minutosRestantes = typeof liveData.minutos_restantes === 'number' ? liveData.minutos_restantes : 10;
  const isAcrescimo      = liveData.is_acrescimo;

  if (minutosRestantes <= 1) {
    console.log(chalk.gray(`    ⏭  ${liveData.minuto_label}' — menos de 1 min restante`));
    return [];
  }
  if (isAcrescimo && minuto >= 97) {
    console.log(chalk.gray(`    ⏭  ${liveData.minuto_label}' — acréscimo muito avançado`));
    return [];
  }

  // Roda os 4 agentes Groq em paralelo — schema OpenAI-compatible via Groq API
  const rawResults = await Promise.all(
    AGENTS.map((a) => a.analyze(liveData).catch(() => null))
  );
  const allResults = rawResults.filter(Boolean).flat();

  // Gate triplo + kill switches
  const approved = allResults.filter((r) => _applyGates(r, liveData));

  // Dedup unificado — chave idêntica ao funnel-live-2t para evitar envio duplo
  const matchKey = `${match.home_team}_${match.away_team}`;
  const keys     = sharedNotifiedKeys instanceof Map ? sharedNotifiedKeys : new Map();
  const novos = approved.filter((r) => {
    const key = `superodds_${matchKey}_${r.mercado}_${liveData.placar}`;
    if (keys.has(key)) return false;
    keys.set(key, Date.now());
    return true;
  });

  if (novos.length) {
    saveLiveOpportunity(liveData, novos, 'superodds');
  }

  return novos;
}

// ── Gate triplo + Kill Switches ───────────────────────────────────────────────
/**
 * Aplica o gate triplo (prob × confiança × combined) e os kill switches.
 *
 * Métrica **combined** = (probabilidade × confiança) / 100
 * Threshold mínimo: 64 = 80² / 100
 *
 * Garante que ambos os valores sejam simultaneamente altos.
 * Exemplo: prob=80, conf=79 → combined=63.2 → BLOQUEADO
 *          prob=80, conf=80 → combined=64.0 → PASSE mínimo
 *
 * @param {object} r       - resultado do agente
 * @param {object} liveData - dados ao vivo
 * @returns {boolean}
 */
function _applyGates(r, liveData) {
  const prob     = r.probabilidade ?? 0;
  const conf     = r.confianca     ?? 0;
  const combined = (prob * conf) / 100;

  if (prob     < MIN_PROBABILITY)     return false;
  if (conf     < MIN_CONFIDENCE)      return false;
  if (combined < MIN_COMBINED)        return false;
  if (r.recomendacao !== 'APOSTAR')   return false;

  const mkt = (r.mercado || r.market || '').trim();

  // BTTS Sniper v3
  if (mkt === 'BTTS' || mkt === 'Ambas Marcam') {
    const killReason = bttsKillSwitch(r, liveData);
    if (killReason) {
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${killReason}`));
      trackBttsDecision('blocked', r, liveData, killReason, 'superodds');
      return false;
    }
    const minProb = bttsMinProbability(liveData.competition);
    if (prob < minProb) {
      const reason = `Threshold — prob ${prob}% < ${minProb}%`;
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${reason}`));
      trackBttsDecision('blocked', r, liveData, reason, 'superodds');
      return false;
    }
    if (conf < BTTS_MIN_CONFIDENCE) {
      const reason = `Threshold — confiança ${conf}% < ${BTTS_MIN_CONFIDENCE}%`;
      console.log(chalk.gray(`    🚫 [BTTS Sniper SUPERODDS] ${reason}`));
      trackBttsDecision('blocked', r, liveData, reason, 'superodds');
      return false;
    }
    trackBttsDecision('fired', r, liveData, null, 'superodds');
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
      trackGoalsDecision('blocked', r, liveData, goalsBlock, 'superodds');
      return false;
    }
    const minProbGoals = goalsMinProbability(mkt, liveData.competition);
    if (prob < minProbGoals) {
      const reason = `Threshold — prob ${prob}% < ${minProbGoals}%`;
      console.log(chalk.gray(`    🚫 [Goals Sniper SUPERODDS] ${reason}`));
      trackGoalsDecision('blocked', r, liveData, reason, 'superodds');
      return false;
    }
    if (conf < GOALS_MIN_CONFIDENCE) {
      const reason = `Threshold — confiança ${conf}% < ${GOALS_MIN_CONFIDENCE}%`;
      console.log(chalk.gray(`    🚫 [Goals Sniper SUPERODDS] ${reason}`));
      trackGoalsDecision('blocked', r, liveData, reason, 'superodds');
      return false;
    }
    trackGoalsDecision('fired', r, liveData, null, 'superodds');
    console.log(chalk.cyan(`    🎯 [Goals Sniper SUPERODDS] DISPARO aprovado — ${mkt} ${prob}%/conf ${conf}%`));
  }

  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _printBanner(loop, intervalMin) {
  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║  🔮 BET ANALYSIS SQUAD — SUPERODDS IN-PLAY           ║
║  Jogos ao vivo · Groq (4 agentes paralelos)          ║
║  Gate: Prob ≥ ${MIN_PROBABILITY}% · Confiança ≥ ${MIN_CONFIDENCE}% · Combined ≥ ${MIN_COMBINED}  ║${loop ? `
║  Modo: Loop a cada ${String(intervalMin).padEnd(2)} minuto(s)                    ║` : `
║  Modo: Scan único                                    ║`}
╚══════════════════════════════════════════════════════╝
  `));
}

function timestamp() {
  return new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
