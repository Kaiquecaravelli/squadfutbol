import { trackOdds } from '../agents/odds-tracker.js';
import { notifySteamAlert } from '../utils/telegram.js';
import chalk from 'chalk';

const POLL_INTERVAL_MS = 60_000; // 1 minuto
const STEAM_THRESHOLD_PCT = 8;   // variação >= 8% = steam move

/**
 * Monitora odds de uma partida em tempo real.
 * Detecta steam moves e alerta via terminal + Telegram.
 */
export async function startLiveMonitoring(matchData, durationMinutes = 60) {
  const endTime = Date.now() + durationMinutes * 60_000;
  const snapshots = [];

  console.log(chalk.bold.cyan(`\n📡 [Live Monitor] Monitorando: ${matchData.match}`));
  console.log(chalk.gray(`   Duração: ${durationMinutes} minutos | Intervalo: 1 minuto\n`));

  while (Date.now() < endTime) {
    try {
      const snapshot = await trackOdds(matchData);
      snapshot.timestamp = new Date().toISOString();
      snapshots.push(snapshot);

      printLiveStatus(snapshot, snapshots.length);

      // Alertas de steam move
      for (const alert of snapshot.alerts || []) {
        console.log(chalk.bold.red(`\n  🚨 ${alert}\n`));
        await notifySteamAlert(matchData.match, alert).catch(() => {});
      }

      // Detectar variação desde o primeiro snapshot
      if (snapshots.length > 1) {
        const drifts = detectDrifts(snapshots[0], snapshot);
        for (const drift of drifts) {
          if (Math.abs(drift.pct) >= STEAM_THRESHOLD_PCT) {
            const msg = `Steam move acumulado — ${drift.market}: ${drift.pct > 0 ? '+' : ''}${drift.pct}% desde início do monitoramento`;
            console.log(chalk.bold.yellow(`  ⚡ ${msg}`));
            await notifySteamAlert(matchData.match, msg).catch(() => {});
          }
        }
      }

      await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error(chalk.red(`  [Live Monitor] Erro: ${err.message}`));
      await sleep(5000);
    }
  }

  printLiveSummary(matchData.match, snapshots);
  return snapshots;
}

function printLiveStatus(snapshot, tick) {
  const time = new Date().toLocaleTimeString('pt-BR');
  const oddsLine = Object.entries(snapshot.current_odds || {})
    .map(([house, odds]) => `${house}: ${odds.home_win ?? '?'}/${odds.draw ?? '?'}/${odds.away_win ?? '?'}`)
    .join(' | ');

  process.stdout.write(chalk.gray(`  [${time}] #${tick} ${oddsLine}   \r`));
}

function detectDrifts(first, current) {
  const drifts = [];
  for (const house of Object.keys(first.current_odds || {})) {
    const firstOdds = first.current_odds[house];
    const currOdds = current.current_odds?.[house];
    if (!firstOdds || !currOdds) continue;

    for (const market of ['home_win', 'draw', 'away_win', 'over_2_5']) {
      const o = firstOdds[market], c = currOdds[market];
      if (!o || !c) continue;
      const pct = +((c - o) / o * 100).toFixed(1);
      if (Math.abs(pct) >= STEAM_THRESHOLD_PCT) {
        drifts.push({ house, market, from: o, to: c, pct });
      }
    }
  }
  return drifts;
}

function printLiveSummary(matchName, snapshots) {
  console.log(chalk.bold.cyan(`\n\n📊 [Live Monitor] Resumo — ${matchName}`));
  console.log(`  Snapshots coletados: ${snapshots.length}`);

  if (snapshots.length >= 2) {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const drifts = detectDrifts(first, last);

    if (drifts.length) {
      console.log(chalk.yellow('\n  Movimentos significativos detectados:'));
      for (const d of drifts) {
        console.log(`  • ${d.house} | ${d.market}: ${d.from} → ${d.to} (${d.pct > 0 ? '+' : ''}${d.pct}%)`);
      }
    } else {
      console.log(chalk.green('  Sem movimentos significativos.'));
    }
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
