import 'dotenv/config';
import chalk from 'chalk';
import cron from 'node-cron';
import { runFullMatchAnalysis } from './workflows/full-match-analysis.js';
import { runDailyScan } from './workflows/daily-scan.js';
import { startLiveMonitoring } from './workflows/live-monitoring.js';
import { startAutoMonitor } from './workflows/auto-monitor.js';
import { startLiveScan } from './workflows/live-scan.js';
import { runLive2TFunnel } from './funnels/funnel-live-2t.js';
import { runPreLiveFunnel } from './funnels/funnel-pre-live.js';
import { getRoiStats, getRecentAnalyses, logBet, updateBetResult } from './utils/storage.js';
import { isObsidianConfigured } from './utils/obsidian.js';
import { notifyDailySummary, getGroupId, notifyPreLiveOpportunity, notifyLive2TOpportunity } from './utils/telegram.js';
import { aggregateUpcomingMatches } from './scrapers/aggregator.js';
import { DEMO_MATCHES } from './utils/mock-data.js';

const [,, command, ...args] = process.argv;
const DEMO_MODE = process.env.DEMO_MODE === 'true' || args.includes('--demo');

async function main() {
  printBanner();

  switch (command) {

    case 'analyze': {
      const matchId = args.filter((a) => !a.startsWith('--'))[0];
      if (!matchId && !DEMO_MODE) {
        console.error(chalk.red('Uso: node src/index.js analyze <match_id> [--demo]'));
        process.exit(1);
      }
      const id = matchId || 'demo_001';
      await runFullMatchAnalysis(id);
      break;
    }

    case 'auto': {
      // Modo automático — scrape FlashScore + análise + Telegram
      await startAutoMonitor();
      break;
    }

    case 'live-scan': {
      // Análise de jogos em andamento (in-play) em tempo real
      const loop        = args.includes('--loop');
      const intervalArg = args.find((a) => a.startsWith('--interval='));
      const maxArg      = args.find((a) => a.startsWith('--max='));
      const intervalMin = intervalArg ? parseInt(intervalArg.split('=')[1]) : undefined;
      const maxMatches  = maxArg      ? parseInt(maxArg.split('=')[1])      : undefined;
      await startLiveScan({ loop, intervalMin, maxMatches });
      break;
    }

    case 'live-2t': {
      // Funil exclusivo de 2° Tempo — jogos no min 46+
      console.log(chalk.bold.yellow('🟡 FUNIL LIVE 2T — Analisando jogos no 2° Tempo...\n'));
      const results = await runLive2TFunnel(new Map());
      if (!results.length) {
        console.log(chalk.gray('  Nenhuma oportunidade encontrada no 2° Tempo.'));
      } else {
        for (const r of results) {
          console.log(chalk.green(`  ✅ ${r._liveData?.match}  →  ${r.mercado}  ${r.probabilidade}%  ${r.recomendacao}`));
        }
      }
      break;
    }

    case 'pre-live': {
      // Funil PRÉ-LIVE — analisa próximas 24h e envia alertas Telegram
      console.log(chalk.bold.green('🟢 FUNIL PRÉ-LIVE — Buscando jogos nas próximas 24h...\n'));
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const now         = Date.now();
      const horasDec    = (now - startOfDay.getTime()) / 3_600_000;
      const horasBusca  = Math.min(24 + horasDec, 48);
      const date        = startOfDay.toISOString().split('T')[0];
      const all         = await aggregateUpcomingMatches(date, horasBusca);
      const limite      = new Date(now + 24 * 3_600_000);
      const filtrados   = all.filter((m) => {
        if (!m.date) return true;
        const t = new Date(m.date).getTime();
        return t >= now - 3_600_000 && t <= limite.getTime();
      });
      console.log(chalk.white(`  ${filtrados.length} jogos encontrados\n`));
      const preLiveResults = await runPreLiveFunnel(filtrados, new Map());
      if (!preLiveResults.length) {
        console.log(chalk.gray('  Nenhuma oportunidade pré-jogo encontrada.'));
      } else {
        for (const r of preLiveResults) {
          console.log(chalk.green(`  ✅ ${r.matchData.match}  →  ${r.enriched.length} mercado(s)`));
          await notifyPreLiveOpportunity(r.matchData, r.enriched).catch(() => {});
        }
      }
      break;
    }

    case 'demo': {
      // Modo demo: analisa as 3 partidas de demonstração
      console.log(chalk.bold.yellow('🎮 MODO DEMO — Usando dados simulados (sem API real)\n'));
      for (const match of DEMO_MATCHES) {
        await runFullMatchAnalysis(match.match_id, { demo: true });
        console.log('\n' + '─'.repeat(60) + '\n');
      }
      break;
    }

    case 'daily-scan': {
      const dateArg = args.filter((a) => !a.startsWith('--'))[0];
      const analyses = await runDailyScan(dateArg);
      await notifyDailySummary(analyses).catch(() => {});
      break;
    }

    case 'live': {
      const matchId = args.filter((a) => !a.startsWith('--'))[0];
      const minutes = parseInt(args.find((a) => a.startsWith('--minutes='))?.split('=')[1] || '60');
      if (!matchId) {
        console.error(chalk.red('Uso: node src/index.js live <match_id> [--minutes=60]'));
        process.exit(1);
      }
      // Coleta dados básicos primeiro
      const { collectMatchData } = await import('./agents/scout.js');
      const { getMockMatch } = await import('./utils/mock-data.js');
      const matchData = DEMO_MODE ? getMockMatch(matchId) : await collectMatchData(matchId);
      await startLiveMonitoring(matchData, minutes);
      break;
    }

    case 'schedule': {
      const time = args[0] || '0 8 * * *'; // default: 08:00 diário
      console.log(chalk.cyan(`⏰ Agendador ativo — Daily Scan: ${time}\n`));
      console.log(chalk.gray('  Pressione Ctrl+C para parar.\n'));

      cron.schedule(time, async () => {
        console.log(chalk.bold(`\n[${new Date().toLocaleString('pt-BR')}] Iniciando Daily Scan automático...`));
        try {
          const analyses = await runDailyScan();
          await notifyDailySummary(analyses).catch(() => {});
        } catch (err) {
          console.error(chalk.red(`Erro no Daily Scan: ${err.message}`));
        }
      });

      await new Promise(() => {}); // mantém processo vivo
      break;
    }

    case 'roi': {
      const stats = await getRoiStats();
      if (!stats.total_bets) {
        console.log(chalk.yellow('Nenhuma aposta registrada ainda.'));
        break;
      }
      const winRate = ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1);
      console.log(chalk.bold('\n📈 ROI Report\n'));
      console.log(`  Total apostas : ${stats.total_bets}`);
      console.log(`  ✅ Vitórias   : ${stats.wins}   ❌ Derrotas: ${stats.losses}`);
      console.log(`  Win Rate      : ${winRate}%`);
      console.log(`  Total apostado: R$ ${stats.total_staked}`);
      const profitColor = stats.total_profit >= 0 ? 'green' : 'red';
      console.log(chalk[profitColor](`  Lucro/Prejuízo: R$ ${stats.total_profit}`));
      console.log(chalk[profitColor](chalk.bold(`  ROI           : ${stats.roi_pct}%`)));
      break;
    }

    case 'history': {
      const limit = parseInt(args[0]) || 10;
      const recent = await getRecentAnalyses(limit);
      if (!recent.length) { console.log('Nenhuma análise no histórico.'); break; }
      console.log(chalk.bold(`\n📋 Últimas ${limit} análises:\n`));
      for (const a of recent) {
        const icon = a.recommendation === 'BET' ? '✅' : a.recommendation === 'CONSIDER' ? '⚡' : '❌';
        const ev = a.ev ? ` | EV: ${(a.ev * 100).toFixed(1)}%` : '';
        console.log(`  ${icon} ${a.match_name}`);
        console.log(chalk.gray(`     ${a.created_at} | Score: ${a.confidence_score} | ${a.recommendation}${ev}`));
      }
      break;
    }

    case 'log-bet': {
      // log-bet <analysis_id> <stake> <odds> <house>
      const [analysisId, stake, odds, house] = args;
      if (!analysisId || !stake || !odds || !house) {
        console.error(chalk.red('Uso: node src/index.js log-bet <analysis_id> <stake> <odds> <house>'));
        process.exit(1);
      }
      const bankroll = parseFloat(process.env.USER_BANKROLL || 1000);
      const betId = await logBet({
        analysisId: parseInt(analysisId),
        matchName: `Aposta #${analysisId}`,
        market: 'Manual',
        odds: parseFloat(odds),
        house,
        stake: parseFloat(stake),
        bankroll,
      });
      console.log(chalk.green(`✅ Aposta registrada — ID: ${betId}`));
      break;
    }

    case 'result': {
      // result <bet_id> <win|loss|void> [obsidian_file_path]
      const [betId, result, obsidianFile] = args;
      if (!betId || !['win', 'loss', 'void'].includes(result)) {
        console.error(chalk.red('Uso: node src/index.js result <bet_id> <win|loss|void> [caminho_nota_obsidian]'));
        process.exit(1);
      }
      await updateBetResult(parseInt(betId), result, null);
      if (obsidianFile) {
        const { updateObsidianResult } = await import('./utils/obsidian.js');
        updateObsidianResult(obsidianFile, result);
      }
      console.log(chalk.green(`✅ Resultado registrado: Aposta ${betId} = ${result}`));
      break;
    }

    case 'get-group-id': {
      await getGroupId();
      break;
    }

    case 'backfill': {
      // Tenta buscar resultados retroativos para predições sem resultado no PIE
      // Uso: node src/index.js backfill [--dry-run]
      const dryRun = args.includes('--dry-run');
      const { getPendingPredictions, getPredictionById } = await import('./pie/pie-storage.js');
      const { fetchEventResult } = await import('./utils/result-fetcher.js');
      const { analyzeResult } = await import('./pie/pie-analyzer.js');

      const pending = getPendingPredictions();

      // Tenta recuperar sofascore_id para predições sem ID via busca por data na API
      const { default: axios } = await import('axios');
      const sfHttp = axios.create({
        baseURL: 'https://api.sofascore.com/api/v1',
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.sofascore.com/' },
      });

      const _normName = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

      for (const pred of pending) {
        if (pred.sofascore_id || !pred.match_date) continue;
        try {
          const date = pred.match_date.split('T')[0];
          const res  = await sfHttp.get(`/sport/football/scheduled-events/${date}`).catch(() => null);
          if (!res) continue;
          const events = res.data?.events || [];
          const parts  = pred.match_name.split(' vs ');
          const homeQ  = _normName(parts[0]);
          const awayQ  = _normName(parts[1]);
          const found  = events.find((e) =>
            _normName(e.homeTeam?.name).includes(homeQ.slice(0, 6)) &&
            _normName(e.awayTeam?.name).includes(awayQ.slice(0, 6))
          );
          if (found?.id) {
            // Atualiza o sofascore_id na predição em memória para uso imediato
            pred.sofascore_id = found.id;
          }
        } catch { /* ignora erros de busca */ }
        await new Promise((r) => setTimeout(r, 400));
      }

      const comSofaId = pending.filter((p) => p.sofascore_id);
      const semSofaId = pending.filter((p) => !p.sofascore_id);

      console.log(chalk.bold('\n🔁 BACKFILL — Buscando resultados retroativos\n'));
      console.log(`  Predições pendentes: ${pending.length}`);
      console.log(`  Com SofaScore ID   : ${comSofaId.length}`);
      console.log(chalk.gray(`  Sem SofaScore ID   : ${semSofaId.length} (não recuperáveis automaticamente)\n`));

      if (dryRun) {
        console.log(chalk.yellow('  [DRY-RUN] Nenhuma escrita realizada.\n'));
        for (const p of comSofaId) {
          console.log(chalk.cyan(`  • ${p.match_name} (sofascore_id: ${p.sofascore_id}) — ${p.created_at.slice(0,10)}`));
        }
        break;
      }

      let acertos = 0, erros = 0, naoEncontrados = 0;
      for (const pred of comSofaId) {
        process.stdout.write(chalk.cyan(`  🔍 ${pred.match_name}... `));
        const result = await fetchEventResult(pred.sofascore_id).catch(() => null);

        if (!result) {
          process.stdout.write(chalk.gray('ainda em andamento ou não encontrado\n'));
          naoEncontrados++;
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        if (result.abandoned) {
          process.stdout.write(chalk.yellow(`adiado/cancelado (${result.status})\n`));
          naoEncontrados++;
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        process.stdout.write(chalk.green(`✅ ${result.placar}\n`));
        const pieResult = analyzeResult(pred, result.placar);
        acertos++;
        if (pieResult.newLessons.length) {
          console.log(chalk.gray(`      → ${pieResult.newLessons.length} lição(ões) gerada(s)`));
        }
        await new Promise((r) => setTimeout(r, 600));
      }

      console.log(chalk.bold(`\n  Concluído: ${acertos} resultados registrados | ${naoEncontrados} não encontrados`));
      if (semSofaId.length) {
        console.log(chalk.gray(`\n  Para registrar manualmente as ${semSofaId.length} predições sem ID:`));
        console.log(chalk.gray(`  node src/index.js resultado-manual <prediction_id> <placar>`));
      }
      break;
    }

    case 'resultado-manual': {
      // Registra resultado diretamente por ID de predição (sem precisar do bot rodando)
      // Uso: node src/index.js resultado-manual <prediction_id_ou_idx> <placar>
      const [idArg, placarArg] = args.filter((a) => !a.startsWith('--'));
      if (!idArg || !placarArg) {
        console.error(chalk.red('Uso: node src/index.js resultado-manual <prediction_id> <X-X>'));
        process.exit(1);
      }
      const { getPredictionByIdx: getByIdx, getPredictionById: getById } = await import('./pie/pie-storage.js');
      const { analyzeResult: analyze } = await import('./pie/pie-analyzer.js');

      // Aceita tanto UUID completo quanto idx numérico
      const pred = /^\d+$/.test(idArg) ? getByIdx(parseInt(idArg)) : getById(idArg);
      if (!pred) {
        console.error(chalk.red(`❌ Predição "${idArg}" não encontrada ou já tem resultado.`));
        process.exit(1);
      }

      console.log(chalk.bold(`\n📊 Registrando resultado manualmente`));
      console.log(`  Partida  : ${pred.match_name}`);
      console.log(`  Predição : ${pred.id}`);
      console.log(`  Mercados : ${pred.markets.map((m) => m.market).join(', ')}`);
      console.log(`  Placar   : ${placarArg}\n`);

      const pieResult = analyze(pred, placarArg);
      const acertos = pieResult.marketOutcomes.filter((o) => o.acertou === true).length;
      const erros   = pieResult.marketOutcomes.filter((o) => o.acertou === false).length;
      const nd      = pieResult.marketOutcomes.filter((o) => o.acertou === null).length;

      for (const o of pieResult.marketOutcomes) {
        const icon = o.acertou === true ? '✅' : o.acertou === false ? '❌' : '⚪';
        console.log(`  ${icon} ${o.market} — ${o.recommendation} (${o.probabilidade}%)`);
      }

      console.log(chalk.bold(`\n  Resultado: ${acertos} acertos | ${erros} erros | ${nd} não verificáveis`));
      if (pieResult.newLessons.length) {
        console.log(chalk.yellow(`  📚 ${pieResult.newLessons.length} lição(ões) gerada(s)`));
      }
      console.log(chalk.green(`\n✅ PIE atualizado com sucesso.`));
      break;
    }

    case 'pie-status': {
      // Exibe o estado atual do PIE: calibração, lições, estatísticas
      const { getStats: pieStats, getAllActiveLessons: getLicoes, getPositivePatterns } = await import('./pie/pie-storage.js');
      const { generateTrainingReport } = await import('./pie/pie-trainer.js');

      const stats = pieStats();
      const licoes = getLicoes();
      const report = generateTrainingReport();

      console.log(chalk.bold('\n🧠 PIE — Estado do Sistema\n'));
      console.log(`  Predições totais : ${stats.total}`);
      console.log(`  Verificáveis     : ${stats.verificaveis}`);
      console.log(`  ✅ Acertos        : ${stats.acertos}`);
      console.log(`  ❌ Erros          : ${stats.erros}`);
      console.log(`  Taxa de acerto   : ${stats.taxaAcerto ? stats.taxaAcerto + '%' : 'sem dados'}`);
      console.log(`  Lições ativas    : ${stats.licoesAtivas} / ${stats.licoesTotal}`);

      if (report.length) {
        console.log(chalk.bold('\n  📊 Calibração por mercado:\n'));
        for (const r of report) {
          const biasIcon = r.bias === 'over' ? '⚠️ ' : r.bias === 'under' ? '📈' : '✅';
          console.log(`  ${biasIcon} ${r.market.padEnd(22)} ${r.acuracia.padEnd(7)} (${r.amostras} amostras | baseline ${r.baseline})`);
        }
      } else {
        console.log(chalk.gray('\n  Nenhuma calibração disponível ainda — registre resultados.'));
      }

      if (licoes.length) {
        console.log(chalk.bold('\n  📚 Lições ativas:\n'));
        for (const l of licoes.slice(0, 5)) {
          const w = (l.weight || 1) >= 2 ? '🔴' : '🟡';
          console.log(`  ${w} [${l.market || 'cross'}] ${l.directive.slice(0, 100)}`);
        }
      }
      break;
    }

    case 'obsidian-status': {
      if (isObsidianConfigured()) {
        console.log(chalk.green(`✅ Obsidian configurado — Vault: ${process.env.OBSIDIAN_VAULT_PATH}`));
        console.log(chalk.gray(`   Pasta: ${process.env.OBSIDIAN_FOLDER || 'Apostas Futebol'}`));
      } else {
        console.log(chalk.yellow('⚠️  Obsidian não configurado.'));
        console.log(chalk.gray('   Defina OBSIDIAN_VAULT_PATH no arquivo .env'));
        console.log(chalk.gray('   Exemplo: OBSIDIAN_VAULT_PATH=C:/Users/Você/Documents/MeuVault'));
      }
      break;
    }

    default: {
      showHelp();
    }
  }
}

function printBanner() {
  const demoTag = DEMO_MODE ? chalk.yellow(' [DEMO]') : '';
  console.log(chalk.bold.green(`
  ╔═══════════════════════════════════════════╗
  ║   ⚽ Betting Analysis Squad${demoTag}
  ║   Superbet | Powered by AIOS              ║
  ╚═══════════════════════════════════════════╝
  `));
}

function showHelp() {
  console.log(chalk.bold('Comandos:\n'));
  const cmds = [
    ['auto',                         '🤖 AUTO: FlashScore + análise + Telegram (loop automático)'],
    ['demo',                         '🎮 Demo com 3 partidas simuladas (sem API)'],
    ['analyze <match_id> [--demo]',  'Análise completa de uma partida'],
    ['daily-scan [date]',            'Varredura diária (YYYY-MM-DD)'],
    ['live <match_id> [--minutes=N]','Monitoramento ao vivo de odds'],
    ['schedule [cron]',              'Agendador automático (padrão: 08:00)'],
    ['roi',                          'Relatório de ROI acumulado'],
    ['history [N]',                  'Histórico das últimas N análises'],
    ['log-bet <id> <stake> <odds> <house>', 'Registrar aposta realizada'],
    ['live-scan [--loop] [--interval=N] [--max=N]', '🔴 Análise de jogos ao vivo (in-play) agora'],
    ['live-2t',                                     '🟡 Funil exclusivo 2° Tempo (min 46+)'],
    ['pre-live',                                    '🟢 Funil pré-jogo manual (próximas 24h)'],
    ['result <bet_id> <win|loss|void> [nota_obsidian]', 'Registrar resultado (atualiza Obsidian se informado)'],
    ['obsidian-status',                    '📓 Verificar configuração do Obsidian'],
    ['pie-status',                         '🧠 Estado do PIE: calibração, lições, estatísticas'],
    ['backfill [--dry-run]',               '🔁 Busca resultados retroativos via SofaScore para predições sem resultado'],
    ['resultado-manual <id> <X-X>',        '📊 Registrar resultado manualmente por ID ou idx de predição'],
  ];

  for (const [cmd, desc] of cmds) {
    console.log(`  ${chalk.cyan(`node src/index.js ${cmd}`)}`);
    console.log(chalk.gray(`    ${desc}\n`));
  }

  console.log(chalk.bold('Exemplo rápido (sem API):'));
  console.log(chalk.yellow('  node src/index.js demo\n'));
}

main().catch((err) => {
  console.error(chalk.red(`\n❌ Erro fatal: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
