/**
 * btts-analysis.js — Modelo BTTS Alta Precisão (≥85%)
 *
 * REGRA 1: Apenas LaLiga, Eredivisie, Premier League, Bundesliga, Brasileirão
 * REGRA 2: prob_calibrada = prob_modelo × 0.75 | avança se prob_modelo ≥ 80%
 * REGRA 3: Filtros F1-F6 todos obrigatórios
 * REGRA 4: score ≥ 0.72 para emitir predição
 */

import axios from 'axios';
import chalk from 'chalk';

const API_BASE = 'https://api.sofascore.com/api/v1';
const http = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.sofascore.com/',
  },
});

// ── REGRA 1: Ligas permitidas por ID SofaScore (inviolável) ──────────────────
// IDs verificados empiricamente — blindados contra false-positives
// Verificação: node -e "require script que lista tournament IDs do dia"
const ALLOWED_TOURNAMENT_IDS = {
  17:  { name: 'Premier League',  precision: 0.688 },  // England — verified
  35:  { name: 'Bundesliga',      precision: 0.681 },  // Germany 1st — verified
  8:   { name: 'LaLiga',          precision: 0.719 },  // Spain 1st
  37:  { name: 'Eredivisie',      precision: 0.730 },  // Netherlands
  325: { name: 'Brasileirão',     precision: 0.671 },  // Brazil Serie A — verified
  // NOTA: 238 é Liga Portugal (NÃO LaLiga). Removido.
  // NOTA: 390 é Brasileirão Série B. Removido.
};

// Fallback por nome — apenas quando ID não confirma, com matching EXATO
const ALLOWED_NAMES_EXACT = new Set([
  'premier league',
  'bundesliga',
  'laliga',
  'la liga',
  'eredivisie',
  'brasileirão',
  'brasileirao serie a',
  'brazilian serie a',
]);

function isAllowedLeague(tournament) {
  const id = tournament?.uniqueTournament?.id ?? tournament?.id;
  const name = (tournament?.name || '').toLowerCase().trim();
  const country = tournament?.category?.country?.name || '';

  // Check por ID (prioritário e blindado)
  if (id && ALLOWED_TOURNAMENT_IDS[id]) {
    return ALLOWED_TOURNAMENT_IDS[id];
  }

  // Fallback por nome EXATO — somente se o ID não confirmou.
  // NUNCA usar substring para evitar falsos positivos (Russian PL, Austrian BL, etc.)
  if (ALLOWED_NAMES_EXACT.has(name)) {
    if (name === 'bundesliga' && country !== 'Germany') return false;
    if (name === 'premier league' && country !== 'England') return false;
    if ((name === 'laliga' || name === 'la liga') && country !== 'Spain') return false;
    if (name === 'eredivisie' && country !== 'Netherlands') return false;
    if (name === 'serie a' && country !== 'Brazil') return false;

    const precision = name.includes('premier') ? 0.688
      : name.includes('bundesliga') ? 0.681
      : (name === 'laliga' || name === 'la liga') ? 0.719
      : name === 'eredivisie' ? 0.730
      : 0.671;
    return { name: tournament.name, precision };
  }

  return false;
}

// ── Buscar partidas dos próximos N dias ───────────────────────────────────────
async function getUpcomingMatches(days = 3) {
  const seen = new Set();
  const matches = [];
  const today = new Date();

  for (let i = 0; i <= days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];

    try {
      const res = await http.get(`/sport/football/scheduled-events/${dateStr}`);
      const events = res.data?.events || [];
      const notStarted = events.filter(e => e.status?.type === 'notstarted');

      for (const e of notStarted) {
        const leagueCheck = isAllowedLeague(e.tournament);
        if (!leagueCheck) continue;

        // Deduplicação por evento ID
        if (seen.has(e.id)) continue;
        seen.add(e.id);

        matches.push({
          sofascore_id: e.id,
          home_team:    e.homeTeam?.name,
          home_id:      e.homeTeam?.id,
          away_team:    e.awayTeam?.name,
          away_id:      e.awayTeam?.id,
          competition:  e.tournament?.name,
          country:      e.tournament?.category?.country?.name || '',
          league_name:  leagueCheck.name,
          league_precision: leagueCheck.precision,
          date:         new Date(e.startTimestamp * 1000).toISOString(),
          match_time:   new Date(e.startTimestamp * 1000).toLocaleTimeString('pt-BR', {
            hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
          }),
          match_date: dateStr,
        });
      }
    } catch (err) {
      console.warn(chalk.yellow(`  [BTTS] Erro ao buscar ${dateStr}: ${err.message}`));
    }

    await new Promise(r => setTimeout(r, 600));
  }

  return matches;
}

// ── Calcular métricas BTTS de um time (últimos 8 jogos) ───────────────────────
function calcBttsMetrics(events, teamId, limit = 8) {
  if (!events?.length) return null;

  const last = events.slice(0, limit);
  let scoredCount      = 0;
  let totalGoalsScored = 0;
  let totalGoalsConceded = 0;
  let scorelessStreak  = 0;
  let streakActive     = true;

  for (const ev of last) {
    const isHome   = ev.homeTeam?.id === teamId;
    const teamGoals = isHome ? (ev.homeScore?.current ?? 0) : (ev.awayScore?.current ?? 0);
    const oppGoals  = isHome ? (ev.awayScore?.current ?? 0) : (ev.homeScore?.current ?? 0);

    totalGoalsScored   += teamGoals;
    totalGoalsConceded += oppGoals;

    if (teamGoals > 0) {
      scoredCount++;
      streakActive = false;
    } else if (streakActive) {
      scorelessStreak++;
    }
  }

  const n = last.length;
  return {
    games:              n,
    scored_rate:        scoredCount / n,
    goals_scored_avg:   totalGoalsScored / n,
    goals_conceded_avg: totalGoalsConceded / n,
    scoreless_streak:   scorelessStreak,
  };
}

// ── Taxa BTTS no H2H (últimos 5 confrontos) ───────────────────────────────────
function calcH2hBtts(h2hData, limit = 5) {
  const events = [
    ...(h2hData?.teamDuel?.homeEvents || []),
    ...(h2hData?.teamDuel?.awayEvents || []),
  ].sort((a, b) => b.startTimestamp - a.startTimestamp).slice(0, limit);

  if (!events.length) return null;

  let bttsCount  = 0;
  let totalGoals = 0;
  for (const ev of events) {
    const h = ev.homeScore?.current ?? 0;
    const a = ev.awayScore?.current ?? 0;
    if (h > 0 && a > 0) bttsCount++;
    totalGoals += h + a;
  }

  return {
    total:      events.length,
    btts_count: bttsCount,
    btts_rate:  bttsCount / events.length,
    avg_goals:  totalGoals / events.length,
  };
}

// ── Modelo de probabilidade (prob_modelo) ─────────────────────────────────────
// Usa a MÉDIA das taxas de marcar (não produto), ajustada pela precisão da liga.
// Formula: prob = média(homeScoredRate, awayScoredRate) × (leaguePrecision / 0.70)
// Exemplo (PL): ambos marcam em 87.5% → prob = 87.5% × 0.983 = 86% → calibrada = 64.5%
function calcProbModelo(homeMetrics, awayMetrics, leaguePrecision) {
  if (!homeMetrics || !awayMetrics) return 0.55;

  const avgScoredRate = (homeMetrics.scored_rate + awayMetrics.scored_rate) / 2;
  const leagueAdjust  = leaguePrecision / 0.70; // normaliza pela baseline 70%

  return Math.min(1.0, Math.max(0.30, avgScoredRate * leagueAdjust));
}

// ── Aplicar filtros REGRA 3 ───────────────────────────────────────────────────
function applyFilters(homeM, awayM, h2h, match) {
  const reasons = [];
  const r = {};

  // F1: ambos marcaram em ≥65% dos últimos 8 jogos
  r.F1 = (homeM?.scored_rate >= 0.65) && (awayM?.scored_rate >= 0.65);
  if (!r.F1) reasons.push(
    `F1: ${match.home_team} ${Math.round((homeM?.scored_rate||0)*100)}%` +
    ` · ${match.away_team} ${Math.round((awayM?.scored_rate||0)*100)}% (mín 65%)`
  );

  // F2: média de gols combinada ≥ 2.8
  const combinedAvg = (homeM?.goals_scored_avg || 0) + (awayM?.goals_scored_avg || 0);
  r.F2 = combinedAvg >= 2.8;
  r.combinedAvg = combinedAvg;
  if (!r.F2) reasons.push(`F2: média gols combinada = ${combinedAvg.toFixed(1)} (mín 2.8)`);

  // F3: H2H BTTS ≥60% (mín 3 confrontos)
  if (!h2h || h2h.total < 3) {
    r.F3 = null;  // dados insuficientes — não bloqueia, penaliza no score
    r.h2h_insufficient = true;
  } else {
    r.F3 = h2h.btts_rate >= 0.60;
    if (!r.F3) reasons.push(`F3: H2H BTTS ${h2h.btts_count}/${h2h.total} = ${Math.round(h2h.btts_rate*100)}% (mín 60%)`);
  }

  // F4: nenhum time em seca de 3+ jogos
  r.F4 = (homeM?.scoreless_streak < 3) && (awayM?.scoreless_streak < 3);
  if (!r.F4) reasons.push(
    `F4: seca de gols — ${match.home_team}: ${homeM?.scoreless_streak} · ${match.away_team}: ${awayM?.scoreless_streak}`
  );

  // F5: não é eliminatória (ligas domésticas → sempre OK)
  r.F5 = true;

  // F6: ausência de artilheiro titular (sem dados em tempo real → N.A.)
  r.F6 = 'N.A.';

  const passed = r.F1 && r.F2 && (r.F3 !== false) && r.F4 && r.F5;
  return { passed, r, reasons };
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function runBttsAnalysis() {
  console.log(chalk.bold.cyan('\n━━━ BTTS HIGH-PRECISION MODEL ━━━'));
  console.log(chalk.gray('Meta: precisão ≥ 85% | Volume esperado: 2–5 predições/rodada\n'));

  console.log(chalk.yellow('► Buscando partidas das ligas permitidas (próximos 3 dias)...'));
  const matches = await getUpcomingMatches(3);
  console.log(chalk.green(`  ✓ ${matches.length} partidas nas 5 ligas aceitas\n`));

  if (!matches.length) {
    console.log(chalk.red('Nenhuma partida encontrada nas ligas permitidas.'));
    return;
  }

  const predictions = [];
  const rejected    = [];

  for (const match of matches) {
    process.stdout.write(chalk.gray(`  [${match.competition}] ${match.home_team} vs ${match.away_team}... `));

    try {
      const [homeEvRes, awayEvRes, h2hRes] = await Promise.allSettled([
        http.get(`/team/${match.home_id}/events/last/0`),
        http.get(`/team/${match.away_id}/events/last/0`),
        http.get(`/event/${match.sofascore_id}/h2h`),
      ]);

      const homeEvents = homeEvRes.status === 'fulfilled' ? homeEvRes.value?.data?.events : null;
      const awayEvents = awayEvRes.status === 'fulfilled' ? awayEvRes.value?.data?.events : null;
      const h2hData    = h2hRes.status   === 'fulfilled' ? h2hRes.value?.data           : null;

      const homeM   = calcBttsMetrics(homeEvents, match.home_id);
      const awayM   = calcBttsMetrics(awayEvents, match.away_id);
      const h2hBtts = calcH2hBtts(h2hData);

      // REGRA 3: Filtros F1-F6
      const { passed, r, reasons } = applyFilters(homeM, awayM, h2hBtts, match);

      if (!passed) {
        process.stdout.write(chalk.red('REPROVADO\n'));
        rejected.push({ match: `${match.home_team} vs ${match.away_team}`, league: match.competition, reasons });
        await new Promise(res => setTimeout(res, 300));
        continue;
      }

      // REGRA 2: recalibração
      const probModelo    = calcProbModelo(homeM, awayM, match.league_precision);
      const probCalibrada = probModelo * 0.75;

      // Gate REGRA 2: prob_modelo ≥ 80% (calibrada ≥ 60%)
      if (probModelo < 0.80) {
        process.stdout.write(chalk.yellow(`ABAIXO DO GATE (modelo ${Math.round(probModelo*100)}%)\n`));
        rejected.push({
          match: `${match.home_team} vs ${match.away_team}`,
          league: match.competition,
          reasons: [`REGRA 2: prob_modelo = ${Math.round(probModelo*100)}% < 80% (calibrada = ${Math.round(probCalibrada*100)}%)`],
        });
        await new Promise(res => setTimeout(res, 300));
        continue;
      }

      // REGRA 4: score composto
      const taxaH2h   = h2hBtts ? h2hBtts.btts_rate : 0.55;  // fallback conservador
      const mediaGols = r.combinedAvg;
      const score     = (probCalibrada * 0.5) + (taxaH2h * 0.25) + ((mediaGols / 6) * 0.25);

      if (score < 0.72) {
        process.stdout.write(chalk.yellow(`SCORE ${score.toFixed(3)} < 0.72\n`));
        rejected.push({
          match: `${match.home_team} vs ${match.away_team}`,
          league: match.competition,
          reasons: [`REGRA 4: score = ${score.toFixed(3)} < 0.72`],
        });
        await new Promise(res => setTimeout(res, 300));
        continue;
      }

      process.stdout.write(chalk.green(`APROVADO ✓ score ${score.toFixed(3)}\n`));
      predictions.push({ match, homeM, awayM, h2hBtts, probModelo, probCalibrada, score, r });

    } catch (err) {
      process.stdout.write(chalk.red(`ERRO: ${err.message}\n`));
    }

    await new Promise(res => setTimeout(res, 400));
  }

  // ── Resultados ──────────────────────────────────────────────────────────────
  console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
  console.log(chalk.bold.cyan(`RESULTADO: ${predictions.length} predições aprovadas / ${matches.length} analisadas`));
  console.log(chalk.gray(`(${rejected.length} rejeitadas)\n`));

  if (!predictions.length) {
    console.log(chalk.bold.yellow('Nenhuma predição BTTS qualificada hoje.\n'));

    console.log(chalk.bold('━━━ CANDIDATOS MAIS PRÓXIMOS DO GATE ━━━'));
    const top = rejected
      .filter(r => r.reasons[0]?.startsWith('REGRA'))
      .slice(0, 5);
    if (top.length) {
      for (const r of top) {
        console.log(chalk.gray(`  [${r.league}] ${r.match}`));
        console.log(chalk.gray(`    → ${r.reasons[0]}`));
      }
    }

    console.log(chalk.bold('\n━━━ MOTIVOS DE REJEIÇÃO POR FILTRO ━━━'));
    const counts = {};
    for (const r of rejected) {
      for (const reason of r.reasons) {
        const key = reason.split(':')[0].trim();
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    for (const [k, v] of Object.entries(counts).sort((a,b) => b[1]-a[1])) {
      console.log(chalk.gray(`  ${k}: ${v} jogos`));
    }
    return;
  }

  // Ordenar por score decrescente
  predictions.sort((a, b) => b.score - a.score);

  console.log(chalk.bold.green('━━━ PREDIÇÕES BTTS ━━━\n'));

  for (const p of predictions) {
    const { match, homeM, awayM, h2hBtts, probModelo, probCalibrada, score, r } = p;
    const level     = score >= 0.82 ? chalk.bold.green('ALTA CONFIANÇA') : chalk.yellow('MÉDIA');
    const oddMinima = (1 / probCalibrada * 1.05).toFixed(2);

    const f1  = r.F1  ? '✅' : '❌';
    const f2  = r.F2  ? '✅' : '❌';
    const f3  = r.F3 === null ? '⚠️ insuf.' : r.F3 ? '✅' : '❌';
    const f4  = r.F4  ? '✅' : '❌';
    const f5  = r.F5  ? '✅' : '❌';

    let risco = 'Mudança na escalação ou jogo estudado defensivamente';
    if (r.h2h_insufficient) risco = 'H2H insuficiente — padrão histórico incerto';
    else if (probCalibrada < 0.65)  risco = 'Margem estreita — um time pode adotar postura cautelosa';

    console.log(chalk.bold(`Jogo: ${match.home_team} vs ${match.away_team}`));
    console.log(`Liga: ${match.competition} | ${match.match_date} às ${match.match_time} (Brasília)`);
    console.log(`Prob. modelo: ${Math.round(probModelo*100)}%  →  Prob. calibrada: ${Math.round(probCalibrada*100)}%`);
    console.log(`${match.home_team}: marcou em ${Math.round(homeM.scored_rate*100)}% · avg ${homeM.goals_scored_avg.toFixed(1)} gols/jogo`);
    console.log(`${match.away_team}: marcou em ${Math.round(awayM.scored_rate*100)}% · avg ${awayM.goals_scored_avg.toFixed(1)} gols/jogo`);
    if (h2hBtts && h2hBtts.total >= 3) {
      console.log(`H2H: BTTS ${h2hBtts.btts_count}/${h2hBtts.total} (${Math.round(h2hBtts.btts_rate*100)}%) · avg ${h2hBtts.avg_goals.toFixed(1)} gols`);
    } else {
      console.log(`H2H: dados insuficientes (${h2hBtts?.total || 0} confrontos registrados)`);
    }
    console.log(`Filtros: F1 ${f1} F2 ${f2} F3 ${f3} F4 ${f4} F5 ${f5} F6 N.A.`);
    console.log(`Score composto: ${score.toFixed(3)}`);
    console.log(`Nível: ${level}`);
    console.log(`Odd mínima recomendada: ${oddMinima}`);
    console.log(`Risco principal: ${risco}`);
    console.log(chalk.gray('─'.repeat(60)));
  }

  // Sumário de rejeições
  if (rejected.length) {
    console.log(chalk.bold('\n━━━ REJEITADOS ━━━'));
    for (const r of rejected) {
      console.log(chalk.gray(`  ✗ [${r.league}] ${r.match} → ${r.reasons[0]}`));
    }
  }

  console.log(chalk.bold.cyan('\n━━━ FIM DA ANÁLISE ━━━\n'));
}

runBttsAnalysis().catch(err => {
  console.error(chalk.red('Erro crítico:'), err.message);
  process.exit(1);
});
