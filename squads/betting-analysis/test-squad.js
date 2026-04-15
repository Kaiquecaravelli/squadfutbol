/**
 * test-squad.js — Testa os 7 Sharp Agents em paralelo
 *
 * Uso:
 *   node squads/betting-analysis/test-squad.js
 *   node squads/betting-analysis/test-squad.js --provider=openai
 *   node squads/betting-analysis/test-squad.js --match="Real Madrid vs Barcelona"
 */

import 'dotenv/config';
import chalk from 'chalk';

import { RebeloAgent }    from './sharp-agents/RebeloAgent.js';
import { BloomAgent }     from './sharp-agents/BloomAgent.js';
import { BenhamAgent }    from './sharp-agents/BenhamAgent.js';
import { WebbAgent }      from './sharp-agents/WebbAgent.js';
import { RanogajacAgent } from './sharp-agents/RanogajacAgent.js';
import { VoulgarisAgent } from './sharp-agents/VoulgarisAgent.js';
import { WaltersAgent }   from './sharp-agents/WaltersAgent.js';

// ── Override de provider via CLI ──────────────────────────────────────────────
const providerArg = process.argv.find((a) => a.startsWith('--provider='));
if (providerArg) process.env.AI_PROVIDER = providerArg.split('=')[1];

// ── Dados de teste da partida ──────────────────────────────────────────────────
const TEST_MATCH = {
  match: 'Flamengo vs Palmeiras',
  competition: 'Brasileirão Série A',
  date: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
  home: {
    team: 'Flamengo',
    xg_for_avg: 2.2,
    xg_against_avg: 0.9,
    goals_scored_avg: 2.1,
    goals_conceded_avg: 0.8,
    form_last5: ['W', 'W', 'D', 'W', 'L'],
    position: 1,
    home_advantage: true,
  },
  away: {
    team: 'Palmeiras',
    xg_for_avg: 1.8,
    xg_against_avg: 1.1,
    goals_scored_avg: 1.6,
    goals_conceded_avg: 1.0,
    form_last5: ['W', 'D', 'W', 'L', 'W'],
    position: 3,
    home_advantage: false,
  },
  h2h: {
    last5_home_wins: 2,
    last5_draws: 2,
    last5_away_wins: 1,
    avg_goals_h2h: 2.6,
  },
  odds: {
    home_win:  2.10,
    draw:      3.20,
    away_win:  3.50,
    over_25:   1.85,
    btts_yes:  1.92,
    double_chance_1x: 1.42,
  },
  market_context: {
    opening_odd_home: 2.20,
    current_odd_home: 2.10,
    line_movement: 'steam_down',
    wom_back_pct: 68,
    wom_lay_pct: 32,
    public_bet_pct_home: 72,
    sharp_action_detected: true,
    liquidity_exchange_home: '€420,000',
  },
  news_impact: {
    home_key_news: 'Gabigol confirmado titular após recuperação',
    away_key_news: 'Sem desfalques relevantes',
    home_impact_score: 8,
    away_impact_score: 0,
  },
  bankroll: 1000,
  kelly_fraction: 0.25,
};

// ── Helpers de display ──────────────────────────────────────────────────────────
const DECISION_COLORS = {
  EXECUTE:              chalk.bold.green,
  EXECUTE_VOLUME:       chalk.bold.green,
  BUY_VALUE:            chalk.bold.green,
  SCALP_ENTRY:          chalk.bold.green,
  HIGH_VOLUME_EXECUTE:  chalk.bold.green,
  ALGO_BEAT_THE_LINE:   chalk.bold.green,
  SHARP_MOVE_ENTRY:     chalk.bold.green,
  REVERSE_PUBLIC_PLAY:  chalk.bold.yellow,
  HEDGE:                chalk.bold.yellow,
  WAIT:                 chalk.bold.yellow,
  WAIT_LIQUIDITY:       chalk.bold.yellow,
  SELL_HYPE:            chalk.bold.yellow,
  NO_CONTEXTUAL_EDGE:   chalk.bold.red,
  NEUTRAL:              chalk.bold.gray,
  PASS:                 chalk.bold.red,
  REJECT:               chalk.bold.red,
  STAY_OUT:             chalk.bold.red,
  NO_PLAY:              chalk.bold.red,
};

function colorDecision(decision) {
  const fn = DECISION_COLORS[decision] || chalk.white;
  return fn(decision);
}

function extractInsight(result) {
  return result.rebelo_logic
    || result.bloom_insight
    || result.benham_insight
    || result.webb_insight
    || result.ranogajec_insight
    || result.voulgaris_insight
    || result.walters_insight
    || '—';
}

function printResult(agentName, role, result, elapsed) {
  console.log(chalk.bold.cyan(`\n┌─ ${agentName.toUpperCase()} ─────────────────────────────────────`));
  console.log(chalk.gray(`│  ${role}`));
  console.log(`│  Decisão : ${colorDecision(result.decision)}`);
  console.log(chalk.gray(`│  Tempo   : ${elapsed}ms`));

  // Exibe campos relevantes conforme o agente
  const skip = new Set(['agent', 'role', 'decision',
    'rebelo_logic', 'bloom_insight', 'benham_insight',
    'webb_insight', 'ranogajec_insight', 'voulgaris_insight', 'walters_insight']);

  for (const [key, val] of Object.entries(result)) {
    if (skip.has(key)) continue;
    const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
    console.log(chalk.gray(`│  ${key.padEnd(18)}: `) + chalk.white(valStr.slice(0, 100)));
  }

  const insight = extractInsight(result);
  console.log(chalk.italic.yellow(`│  💡 "${insight.slice(0, 120)}"`));
  console.log(chalk.bold.cyan(`└${'─'.repeat(52)}`));
}

function printSummary(results) {
  console.log(chalk.bold.white('\n\n══════════════════════════════════════════════════'));
  console.log(chalk.bold.white('  VEREDICTO DO CONSELHO — SHARP AGENTS SQUAD'));
  console.log(chalk.bold.white('══════════════════════════════════════════════════'));

  const positive = ['EXECUTE', 'EXECUTE_VOLUME', 'BUY_VALUE', 'SCALP_ENTRY',
    'HIGH_VOLUME_EXECUTE', 'ALGO_BEAT_THE_LINE', 'SHARP_MOVE_ENTRY', 'REVERSE_PUBLIC_PLAY'];

  const votes = results.map((r) => ({
    agent: r.agent,
    decision: r.decision,
    positive: positive.includes(r.decision),
  }));

  const bullish  = votes.filter((v) => v.positive).length;
  const bearish  = votes.length - bullish;
  const majority = bullish > bearish ? 'OPERAR' : bullish === bearish ? 'DIVIDIDO' : 'PASSAR';
  const pct      = ((bullish / votes.length) * 100).toFixed(0);

  for (const v of votes) {
    const icon = v.positive ? chalk.green('▲') : chalk.red('▼');
    console.log(`  ${icon} ${v.agent.padEnd(12)} ${colorDecision(v.decision)}`);
  }

  console.log('\n' + '─'.repeat(50));
  const consensoColor = bullish >= 5 ? chalk.bold.green : bullish >= 3 ? chalk.bold.yellow : chalk.bold.red;
  console.log(`  Consenso  : ${consensoColor(majority)} (${bullish}/${votes.length} agentes — ${pct}%)`);
  console.log('══════════════════════════════════════════════════\n');
}

// ── Runner principal ──────────────────────────────────────────────────────────
async function runSquad() {
  const provider = process.env.AI_PROVIDER || 'groq';
  const matchArg = process.argv.find((a) => a.startsWith('--match='));
  const matchLabel = matchArg ? matchArg.split('=')[1] : TEST_MATCH.match;

  console.log(chalk.bold.green(`
  ╔══════════════════════════════════════════════════╗
  ║   🧠 SHARP AGENTS SQUAD — CONSELHO DE LENDAS    ║
  ╚══════════════════════════════════════════════════╝`));
  console.log(chalk.bold(`  Partida  : ${matchLabel}`));
  console.log(chalk.bold(`  Provider : ${provider.toUpperCase()}`));
  console.log(chalk.bold(`  Agentes  : 7 lendas consultadas simultaneamente\n`));

  // Instanciar todos os agentes
  const agents = [
    new RebeloAgent(),
    new BloomAgent(),
    new BenhamAgent(),
    new WebbAgent(),
    new RanogajacAgent(),
    new VoulgarisAgent(),
    new WaltersAgent(),
  ];

  // Modo de execução: 'parallel' ou 'staggered' (padrão: staggered para respeitar rate limits)
  const mode      = process.argv.includes('--parallel') ? 'parallel' : 'staggered';
  const batchSize = parseInt(process.env.AGENT_BATCH_SIZE || '3');
  const batchDelay = parseInt(process.env.AGENT_BATCH_DELAY_MS || '4000');

  console.log(chalk.gray(`  Modo: ${mode} | Lote: ${batchSize} agentes | Intervalo: ${batchDelay}ms\n`));

  const start   = Date.now();
  let settled;

  if (mode === 'parallel') {
    // Todos simultâneos — use apenas se tiver plano pago
    const tasks = agents.map(async (agent) => {
      const t0 = Date.now();
      const result = await agent.analyze(TEST_MATCH);
      return { result, elapsed: Date.now() - t0 };
    });
    settled = await Promise.allSettled(tasks);
  } else {
    // Escalonado: lotes de `batchSize` com pausa entre lotes
    settled = [];
    for (let i = 0; i < agents.length; i += batchSize) {
      const batch = agents.slice(i, i + batchSize);
      if (i > 0) {
        process.stdout.write(chalk.gray(`\n  ⏳ Pausa ${batchDelay}ms entre lotes...\n`));
        await new Promise((r) => setTimeout(r, batchDelay));
      }
      const batchTasks = batch.map(async (agent) => {
        const t0 = Date.now();
        const result = await agent.analyze(TEST_MATCH);
        return { result, elapsed: Date.now() - t0 };
      });
      const batchResults = await Promise.allSettled(batchTasks);
      settled.push(...batchResults);
    }
  }
  const total   = Date.now() - start;

  const successResults = [];

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const { result, elapsed } = outcome.value;
      printResult(result.agent, result.role, result, elapsed);
      successResults.push(result);
    } else {
      console.log(chalk.bold.red(`\n⚠️  Agente falhou: ${outcome.reason?.message || 'erro desconhecido'}`));
    }
  }

  if (successResults.length > 0) {
    printSummary(successResults);
  }

  console.log(chalk.gray(`  Tempo total: ${total}ms | ${successResults.length}/${agents.length} agentes responderam\n`));
}

runSquad().catch((err) => {
  console.error(chalk.red(`\n❌ Erro fatal: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
