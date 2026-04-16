/**
 * test-unified-format.js
 * Limpa mensagens do grupo e envia 1 mensagem de cada tipo (LIVE, PRÉ-LIVE, SUPER-ODDS)
 * com dados reais para validar o formato unificado aprovado.
 *
 * Uso: node scripts/test-unified-format.js
 */

import 'dotenv/config';
import chalk from 'chalk';
import {
  deleteGroupMessages,
  notifyMarketAnalysis,
  notifyLiveSecondHalf,
  notifySuperOddsParlay,
} from '../src/utils/telegram.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🧹 Limpando mensagens do grupo...');
  console.log('═'.repeat(60));

  await deleteGroupMessages();
  console.log(chalk.green('  ✓ Chat limpo'));

  await sleep(2000);

  // ── 1. PRÉ-LIVE ─────────────────────────────────────────────
  console.log(chalk.cyan('\n  📤 Enviando PRÉ-LIVE...'));

  const preliveMsgId = await notifyMarketAnalysis(
    {
      match:       'Flamengo vs Palmeiras',
      competition: 'Brasileirão Série A',
      date:        new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      match_time:  '21:30',
    },
    [
      {
        mercado:      'BTTS',
        recomendacao: 'SIM',
        probabilidade: 78,
        confianca:    82,
      },
      {
        mercado:      'Over 2.5',
        recomendacao: 'OVER',
        probabilidade: 71,
        confianca:    76,
      },
    ]
  );
  console.log(preliveMsgId
    ? chalk.green(`  ✓ PRÉ-LIVE enviado (msgId: ${preliveMsgId})`)
    : chalk.red('  ✗ Falha ao enviar PRÉ-LIVE')
  );

  await sleep(2000);

  // ── 2. LIVE (AO VIVO 2° TEMPO) ──────────────────────────────
  console.log(chalk.cyan('\n  📤 Enviando LIVE...'));

  const liveData = {
    match:       'São Paulo vs Corinthians',
    competition: 'Brasileirão Série A',
    minuto:      63,
    minutos_restantes: 27,
    placar:      '1-1',
    gols_casa:   1,
    gols_fora:   1,
    xg_home:     1.42,
    xg_away:     0.87,
    xg_total:    2.29,
    live_stats: {
      posse_casa:       58,
      posse_fora:       42,
      chutes_alvo_casa: 5,
      chutes_alvo_fora: 3,
      escanteios_casa:  7,
      escanteios_fora:  4,
    },
  };

  const liveOpps = [
    {
      mercado:      'Over 2.5',
      recomendacao: 'OVER',
      probabilidade: 83,
      confianca:    79,
      risco:        { label: 'Médio', icon: '🟡' },
      odds:         1.90,
      justificativa: 'xG combinado 2.29 — pressão ofensiva alta no 2T',
    },
  ];

  const liveMsgId = await notifyLiveSecondHalf(liveData, liveOpps, {
    directUrl: 'https://superbet.bet.br/apostas/futebol/brasil/brasileiro-serie-a/todos',
  });

  console.log(liveMsgId
    ? chalk.green(`  ✓ LIVE enviado (msgId: ${liveMsgId})`)
    : chalk.red('  ✗ Falha ao enviar LIVE')
  );

  await sleep(2000);

  // ── 3. SUPER-ODDS ───────────────────────────────────────────
  console.log(chalk.cyan('\n  📤 Enviando SUPER-ODDS...'));

  const parlayOptions = {
    tiers: {
      'Acumulador': {
        available: true,
        best: [
          {
            combined_odds: 4.80,
            confidence:    62,
            combined_prob: 21,
            legs: [
              {
                match:       'Real Madrid vs Bayern Munich',
                competition: 'UEFA Champions League',
                match_date:  new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
                market:      'Over 2.5',
                market_type: 'Gols',
                recomendacao: 'OVER',
                probabilidade: 74,
                confianca:    71,
                superbet_url: 'https://superbet.bet.br/apostas/futebol/europa/champions-league/todos',
              },
              {
                match:       'Chelsea vs Arsenal',
                competition: 'Premier League',
                match_date:  new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
                market:      'BTTS',
                market_type: 'Ambas Marcam',
                recomendacao: 'SIM',
                probabilidade: 70,
                confianca:    68,
                superbet_url: 'https://superbet.bet.br/apostas/futebol/inglaterra/premier-league/todos',
              },
              {
                match:       'PSG vs Inter Milan',
                competition: 'UEFA Champions League',
                match_date:  new Date(Date.now() + 7 * 3600 * 1000).toISOString(),
                market:      '1X',
                market_type: 'Dupla Chance',
                recomendacao: '1X',
                probabilidade: 68,
                confianca:    65,
                superbet_url: 'https://superbet.bet.br/apostas/futebol/europa/champions-league/todos',
              },
            ],
          },
        ],
      },
    },
  };

  const superIds = await notifySuperOddsParlay(parlayOptions, 1000, { maxTiers: 1 });
  console.log(superIds?.length
    ? chalk.green(`  ✓ SUPER-ODDS enviado (msgIds: ${superIds.join(', ')})`)
    : chalk.red('  ✗ Falha ao enviar SUPER-ODDS')
  );

  // ── Resumo ───────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(chalk.bold.green('  ✅ Teste concluído! Verifique o Telegram.'));
  console.log('═'.repeat(60) + '\n');
}

run().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
