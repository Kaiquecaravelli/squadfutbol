import { collectMatchesByDate } from '../agents/scout.js';
import { analyzeQuantitative } from '../agents/quant.js';
import { runFullMatchAnalysis } from './full-match-analysis.js';
import chalk from 'chalk';

const MAX_FULL_ANALYSES = 5;
const MIN_EV_FOR_SHORTLIST = parseFloat(process.env.MIN_EV_THRESHOLD || '0.05');

export async function runDailyScan(date) {
  const scanDate = date || new Date().toISOString().split('T')[0];
  console.log(chalk.bold.cyan(`\n📅 [Daily Scan] Varredura do dia ${scanDate}\n`));

  // FASE 1 — Listar todas as partidas
  const allMatches = await collectMatchesByDate(scanDate);

  if (!allMatches.length) {
    console.log('Nenhuma partida encontrada para hoje.');
    return [];
  }

  // FASE 2 — Triagem rápida por EV estimado
  console.log(`\n🔍 Triagem rápida de ${allMatches.length} partidas...`);
  const shortlist = await quickEvTriagem(allMatches);

  if (!shortlist.length) {
    console.log(chalk.yellow('Nenhuma partida passou o threshold de EV mínimo.'));
    return [];
  }

  console.log(chalk.green(`\n✅ ${shortlist.length} partida(s) na shortlist. Iniciando análise completa das top ${Math.min(shortlist.length, MAX_FULL_ANALYSES)}...\n`));

  // FASE 3 — Análise completa das shortlistadas (máx. 5)
  const analyses = [];
  for (const match of shortlist.slice(0, MAX_FULL_ANALYSES)) {
    try {
      const result = await runFullMatchAnalysis(match.match_id);
      analyses.push({ match: match.match, ...result });
    } catch (err) {
      console.error(`❌ Erro ao analisar ${match.match}: ${err.message}`);
    }
  }

  // FASE 4 — Resumo do dia
  printDailySummary(analyses);

  return analyses;
}

async function quickEvTriagem(matches) {
  const shortlist = [];

  for (const match of matches) {
    try {
      // Mock rápido de coleta básica para triagem
      const mockData = buildMockMatchData(match);
      const quant = analyzeQuantitative(mockData);
      const topEV = quant.value_bets?.[0]?.ev || 0;

      if (topEV >= MIN_EV_FOR_SHORTLIST) {
        shortlist.push({ ...match, estimated_ev: topEV });
        process.stdout.write(chalk.green(' ✅'));
      } else {
        process.stdout.write(chalk.gray(' ·'));
      }
    } catch {
      process.stdout.write(chalk.red(' ✗'));
    }
  }

  console.log('\n');
  return shortlist.sort((a, b) => b.estimated_ev - a.estimated_ev);
}

function buildMockMatchData(match) {
  // Dados de triagem sem chamada de API (usa médias da liga)
  return {
    match_id: match.match_id,
    match: match.match,
    date: match.date,
    competition: match.competition,
    home: { team: 'Home', goals_scored_avg: 1.5, goals_conceded_avg: 1.2, form: 'WWDLW', xg_avg: 1.5 },
    away: { team: 'Away', goals_scored_avg: 1.2, goals_conceded_avg: 1.5, form: 'LWWWD', xg_avg: 1.2 },
    h2h: [],
    odds: { home_win: 2.1, draw: 3.4, away_win: 3.2, over_25: 1.9 },
    weather: null,
  };
}

function printDailySummary(analyses) {
  console.log(chalk.bold.cyan('\n═══════════════════════════════════════════'));
  console.log(chalk.bold.cyan('  📊 RESUMO DO DIA'));
  console.log(chalk.bold.cyan('═══════════════════════════════════════════'));

  const bets = analyses.filter((a) => a.recommendation?.action === 'BET');
  const considers = analyses.filter((a) => a.recommendation?.action === 'CONSIDER');

  console.log(`  Total analisado: ${analyses.length}`);
  console.log(chalk.green(`  ✅ APOSTAR: ${bets.length}`));
  console.log(chalk.yellow(`  ⚡ CONSIDERAR: ${considers.length}`));
  console.log(`  ❌ Ignorar: ${analyses.length - bets.length - considers.length}`);

  if (bets.length) {
    console.log(chalk.bold('\n  🎯 TOP APOSTAS DO DIA:'));
    for (const bet of bets) {
      const top = bet.top_bet;
      console.log(`  • ${bet.match}`);
      if (top) console.log(`    ${top.market} @ ${top.odds} (${top.house}) — EV: ${top.ev_pct} | Score: ${bet.confidence_score}/100`);
    }
  }

  const totalStake = analyses.reduce((sum, a) => sum + (a.risk?.stake || 0), 0);
  console.log(chalk.bold(`\n  💰 Exposição total estimada: R$ ${totalStake.toFixed(2)}`));
  console.log(chalk.cyan('═══════════════════════════════════════════\n'));
}
