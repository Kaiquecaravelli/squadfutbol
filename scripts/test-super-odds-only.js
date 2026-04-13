/**
 * test-super-odds-only.js
 * Limpa o grupo e envia apenas 1 análise Super Odds.
 */
import 'dotenv/config';
import chalk from 'chalk';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const SENT_DB_PATH = join(__dirname, '../data/telegram-sent.json');

import { deleteGroupMessages, notifySuperOddsParlay } from '../src/utils/telegram.js';
import { getSofascoreMatches, getSofascoreMatchDetails } from '../src/scrapers/sofascore.js';
import { GoalsAgent }   from '../squads/betting-analysis/market-agents/GoalsAgent.js';
import { BTTSAgent }    from '../squads/betting-analysis/market-agents/BTTSAgent.js';
import { buildParlayOptions } from '../src/agents/parlay-builder.js';
import { getSuperbetEventMap, findUrlInEventMap } from '../src/scrapers/superbet.js';
import { loadDB } from '../src/pie/pie-storage.js';

const BANKROLL = parseFloat(process.env.USER_BANKROLL || '1000');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = {
  ok:   (t) => console.log(chalk.green(`  ✅ ${t}`)),
  info: (t) => console.log(chalk.white(`  ℹ  ${t}`)),
  warn: (t) => console.log(chalk.yellow(`  ⚠  ${t}`)),
};

// ── 1. Limpa grupo ─────────────────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n══ Limpando grupo Telegram ══'));
try {
  writeFileSync(SENT_DB_PATH, JSON.stringify({ sent: [], protected: [] }, null, 2));
  log.ok('Dedup limpo');
} catch {}
await deleteGroupMessages();
log.ok('Grupo limpo');

// ── 2. Busca partidas ──────────────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n══ Buscando partidas ══'));
const todayStr    = new Date().toISOString().slice(0, 10);
const tomorrowStr = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const [todayMatches, tomorrowMatches] = await Promise.all([
  getSofascoreMatches(todayStr).catch(() => []),
  getSofascoreMatches(tomorrowStr).catch(() => []),
]);
const pool = [...todayMatches, ...tomorrowMatches].slice(0, 14);
log.info(`Pool: ${pool.length} partidas`);

// ── 3. Mapa de eventos Superbet ────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n══ Pré-verificando links Superbet ══'));
const eventMap = await getSuperbetEventMap();
const filtered = pool.filter(m => findUrlInEventMap(eventMap, m.home_team, m.away_team));
log.info(`${filtered.length}/${pool.length} partidas com link confirmado`);

// ── 4. Analisa pernas ──────────────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n══ Analisando pernas ══'));
const db = (() => { try { return loadDB(); } catch { return null; } })();
const legs = [];

for (const scheduledMatch of filtered.slice(0, 10)) {
  const label = `${scheduledMatch.home_team} vs ${scheduledMatch.away_team}`;
  try {
    const matchData = await getSofascoreMatchDetails(scheduledMatch).catch(() => null);
    if (!matchData) { log.warn(`Sem dados: ${label}`); continue; }

    let result = null;
    for (const agent of [new GoalsAgent(), new BTTSAgent()]) {
      try {
        const r = await agent.analyze(matchData);
        if (r && typeof r.probabilidade === 'number' && r.probabilidade >= 70
            && typeof r.confianca === 'number' && r.confianca >= 68) {
          result = r; break;
        }
      } catch {}
      await sleep(600);
    }
    if (!result) { log.info(`  Sem resultado qualificado: ${label}`); continue; }

    const market     = result.mercado || 'Over 2.5';
    const odds       = result.odds_minima_recomendada || 1.75;
    const score      = Math.round((result.probabilidade * 0.6) + (result.confianca * 0.4));
    const pieCal     = db?.calibration?.[market];
    const pieAcc     = pieCal?.total >= 10 ? Math.round((pieCal.hits / pieCal.total) * 100) : null;
    const superbetUrl = findUrlInEventMap(eventMap, scheduledMatch.home_team, scheduledMatch.away_team);

    legs.push({
      match:         matchData.match,
      match_id:      String(scheduledMatch.sofascore_id),
      competition:   scheduledMatch.competition || '?',
      match_date:    scheduledMatch.match_date  || null,
      match_time:    scheduledMatch.match_time  || null,
      market,
      market_type:   result.market  || market,
      recomendacao:  result.recomendacao || 'APOSTAR',
      probabilidade: result.probabilidade ?? score,
      confianca:     result.confianca     ?? score,
      odds:          typeof odds === 'number' ? odds : parseFloat(odds) || 1.75,
      house:         'Superbet',
      confidence:    score,
      ev:            result.ev || 0,
      pie_accuracy:  pieAcc,
      superbet_url:  superbetUrl,
    });

    log.ok(`${label}  →  ${result.market_type || market} ${market} @ ${odds}  |  prob:${result.probabilidade}%  conf:${result.confianca}%  rec:${result.recomendacao}`);
  } catch (e) {
    log.warn(`Erro ${label}: ${e.message}`);
  }
}

log.info(`${legs.length} pernas qualificadas`);
if (!legs.length) { log.warn('Sem pernas — abortando'); process.exit(0); }

// ── 5. Constrói e envia parlay ─────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n══ Enviando Super Odds ══'));
const parlayOptions = buildParlayOptions(legs);

for (const [name, t] of Object.entries(parlayOptions.tiers || {})) {
  if (t.available && t.best?.[0]) {
    const top = t.best[0];
    log.ok(`${name}: ${top.combined_odds}x | conf ${top.confidence}%`);
  }
}

await notifySuperOddsParlay(parlayOptions, BANKROLL, { maxTiers: 1 });
log.ok('Super Odds enviado ao Telegram!');
