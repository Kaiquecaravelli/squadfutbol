#!/usr/bin/env node
/**
 * games-radar.js — Radar de Jogos Mais Importantes do Dia
 *
 * Identifica e ranqueia os jogos mais relevantes usando score composto:
 *   - Peso da liga (Tier 1 = máximo)
 *   - Prestígio dos clubes envolvidos
 *   - Derby / rivalidade histórica
 *   - Horário (jogos ainda a acontecer = prioridade)
 *
 * Uso:
 *   node scripts/games-radar.js            → envia ao Telegram
 *   node scripts/games-radar.js --dry      → só mostra no console
 *   node scripts/games-radar.js --top=10   → altera quantidade de destaques
 *   node scripts/games-radar.js --json     → exporta JSON para outros scripts
 *
 * Saída JSON: data/radar-today.json (consumível pelo prelive-superodds-now.js)
 */

import 'dotenv/config';
import axios  from 'axios';
import chalk  from 'chalk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }           from 'path';
import { fileURLToPath }           from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

const DRY     = process.argv.includes('--dry');
const AS_JSON = process.argv.includes('--json');
const FORCE   = process.argv.includes('--force');
const TOP_N   = parseInt(process.argv.find(a => a.startsWith('--top='))?.split('=')[1] || '12');

// ── Lock diário — evita duplicatas (1x por dia, não por slot) ────────────────
// Usa formato ISO (YYYY-MM-DD) para evitar bugs de locale no Windows
const LOCK_FILE = join(ROOT, 'data/radar-sent.json');

function _todayISO() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    .split('/').reverse().join('-'); // dd/mm/yyyy → yyyy-mm-dd
}

function _radarSentToday() {
  try {
    if (!existsSync(LOCK_FILE)) return false;
    const db = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
    return db.date === _todayISO();
  } catch { return false; }
}

function _markRadarSent() {
  try {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({
      date:    _todayISO(),
      sent_at: new Date().toISOString(),
    }), 'utf-8');
  } catch { /* silencioso */ }
}

const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
};

// ── Peso das ligas ─────────────────────────────────────────────────────────────
const LEAGUE_SCORE = {
  7:   { name: 'Champions League',          score: 10, tier: 1, flag: '🏆' },
  571: { name: 'Europa League',             score: 8,  tier: 1, flag: '🟠' },
  480: { name: 'Conference League',         score: 6,  tier: 2, flag: '🔵' },
  17:  { name: 'Premier League',            score: 10, tier: 1, flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
  8:   { name: 'La Liga',                   score: 9,  tier: 1, flag: '🇪🇸' },
  23:  { name: 'Serie A',                   score: 9,  tier: 1, flag: '🇮🇹' },
  35:  { name: 'Bundesliga',                score: 8,  tier: 1, flag: '🇩🇪' },
  34:  { name: 'Ligue 1',                   score: 7,  tier: 1, flag: '🇫🇷' },
  325: { name: 'Brasileirão Série A',       score: 7,  tier: 1, flag: '🇧🇷' },
  679: { name: 'Copa do Brasil',            score: 6,  tier: 1, flag: '🏆' },
  329: { name: 'Copa Libertadores',         score: 8,  tier: 1, flag: '🌎' },
  390: { name: 'Eredivisie',               score: 5,  tier: 2, flag: '🇳🇱' },
  155: { name: 'Liga Profesional Argentina',score: 5,  tier: 2, flag: '🇦🇷' },
  37:  { name: 'Jupiler Pro League',        score: 4,  tier: 2, flag: '🇧🇪' },
  130: { name: 'Süper Lig',                score: 5,  tier: 2, flag: '🇹🇷' },
  238: { name: 'MLS',                       score: 4,  tier: 2, flag: '🇺🇸' },
};

// ── Clubes de prestígio (bônus por time) ──────────────────────────────────────
// Cada time listado vale +3 pontos no score total do jogo
const PRESTIGE_CLUBS = new Set([
  // Inglaterra
  'Manchester City', 'Manchester United', 'Arsenal', 'Chelsea', 'Liverpool',
  'Tottenham Hotspur', 'Newcastle United', 'Aston Villa', 'Leeds United',
  // Espanha
  'Real Madrid', 'Barcelona', 'Atletico Madrid', 'Athletic Club', 'Real Betis',
  'Villarreal', 'Sevilla', 'Valencia',
  // Itália
  'Inter', 'Juventus', 'AC Milan', 'Napoli', 'Roma', 'Lazio', 'Fiorentina', 'Atalanta',
  // Alemanha
  'Bayern Munich', 'Borussia Dortmund', 'RB Leipzig', 'Bayer Leverkusen',
  'Borussia Mönchengladbach', 'Eintracht Frankfurt',
  // França
  'Paris Saint-Germain', 'Marseille', 'Monaco', 'Lyon', 'Nice', 'Lens',
  // Brasil
  'Flamengo', 'Corinthians', 'Palmeiras', 'São Paulo', 'Grêmio', 'Internacional',
  'Fluminense', 'Botafogo', 'Athletico Paranaense', 'Cruzeiro', 'Vasco',
  'Santos', 'Atlético Mineiro',
  // Argentina
  'River Plate', 'Boca Juniors', 'Racing Club', 'Independiente', 'Vélez Sarsfield',
  'San Lorenzo', 'Estudiantes', 'Talleres',
  // Portugal
  'Benfica', 'Sporting CP', 'Porto',
  // Outros
  'Ajax', 'PSV', 'Feyenoord', 'Galatasaray', 'Fenerbahce', 'Besiktas',
  'Celtic', 'Rangers',
]);

// ── Derbies/Rivalidades conhecidas (bônus de rivalidade) ─────────────────────
const RIVALRIES = [
  // Inglaterra
  ['Manchester City', 'Manchester United'],
  ['Arsenal', 'Tottenham Hotspur'],
  ['Liverpool', 'Everton'],
  ['Chelsea', 'Arsenal'],
  ['Liverpool', 'Manchester United'],
  ['Chelsea', 'Tottenham Hotspur'],
  // Espanha
  ['Real Madrid', 'Barcelona'],
  ['Real Madrid', 'Atletico Madrid'],
  ['Barcelona', 'Atletico Madrid'],
  ['Athletic Club', 'Real Sociedad'],
  // Itália
  ['Inter', 'AC Milan'],
  ['Juventus', 'Inter'],
  ['Roma', 'Lazio'],
  ['Napoli', 'Juventus'],
  // Alemanha
  ['Bayern Munich', 'Borussia Dortmund'],
  // França
  ['Paris Saint-Germain', 'Marseille'],
  ['Paris Saint-Germain', 'Lyon'],
  // Brasil
  ['Flamengo', 'Corinthians'],
  ['Flamengo', 'Fluminense'],
  ['Flamengo', 'Vasco'],
  ['Corinthians', 'São Paulo'],
  ['Corinthians', 'Palmeiras'],
  ['Grêmio', 'Internacional'],
  ['Santos', 'Corinthians'],
  // Argentina
  ['River Plate', 'Boca Juniors'],
  // Outros
  ['Ajax', 'Feyenoord'],
  ['Ajax', 'PSV'],
  ['Celtic', 'Rangers'],
  ['Galatasaray', 'Fenerbahce'],
  ['Galatasaray', 'Besiktas'],
  ['Benfica', 'Sporting CP'],
  ['Benfica', 'Porto'],
  ['Sporting CP', 'Porto'],
];

function isRivalry(home, away) {
  return RIVALRIES.some(([a, b]) =>
    (home.includes(a) || a.includes(home)) && (away.includes(b) || b.includes(away)) ||
    (home.includes(b) || b.includes(home)) && (away.includes(a) || a.includes(away))
  );
}

// ── Score composto de importância ─────────────────────────────────────────────
function scoreMatch(event, leagueInfo) {
  let score = leagueInfo.score;  // base da liga

  const home = event.homeTeam?.name || '';
  const away = event.awayTeam?.name || '';

  // Bônus por clube de prestígio
  if (PRESTIGE_CLUBS.has(home)) score += 3;
  if (PRESTIGE_CLUBS.has(away)) score += 3;

  // Bônus por rivalidade histórica
  if (isRivalry(home, away)) score += 4;

  // Bônus por liga de copa (UCL, Copa Libertadores)
  const lid = event.tournament?.uniqueTournament?.id;
  if ([7, 329].includes(lid)) score += 2;

  // Bônus por horário do dia (jogos nos próximos 6h = mais urgente)
  const now    = Date.now();
  const kickoff = (event.startTimestamp || 0) * 1000;
  const hoursUntil = (kickoff - now) / 3_600_000;
  if (hoursUntil >= 0 && hoursUntil <= 3)  score += 3;
  else if (hoursUntil > 3 && hoursUntil <= 6)  score += 2;
  else if (hoursUntil > 6 && hoursUntil <= 12) score += 1;

  return score;
}

// ── Formatar hora (BRT) ───────────────────────────────────────────────────────
function fmtHora(ts) {
  return new Date(ts * 1000).toLocaleTimeString('pt-BR', {
    hour:     '2-digit',
    minute:   '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}

// ── Mensagem Telegram ─────────────────────────────────────────────────────────
function buildMessage(topGames, totalImportant, dateStr) {
  const SEP = '<b>━━━━━━━━━━━━━━━━━━━━</b>';
  const BR  = '';

  const lines = [
    `📡  <b>RADAR DE JOGOS — ${dateStr}</b>`,
    SEP,
    `⚽  <b>TOP ${topGames.length} JOGOS DO DIA</b>`,
    `<i>Seleção por: liga + clubes + rivalidade + horário</i>`,
    BR,
  ];

  // Agrupa por liga
  const byLeague = {};
  for (const g of topGames) {
    if (!byLeague[g.league]) byLeague[g.league] = [];
    byLeague[g.league].push(g);
  }

  for (const [league, games] of Object.entries(byLeague)) {
    const flag = games[0].flag || '⚽';
    lines.push(`${flag}  <b>${league}</b>`);
    for (const g of games) {
      const rival  = g.rivalry ? '🔥' : '·';
      const stars  = g.prestigeBonus >= 6 ? '⭐⭐' : g.prestigeBonus >= 3 ? '⭐' : '';
      const soon   = g.hoursUntil <= 3 && g.hoursUntil >= 0 ? ' 🔔' : '';
      const status = g.hoursUntil < 0 ? '<i>(em andamento)</i>' : `⏰  ${g.hora}`;
      lines.push(`  ${rival}  ${status}  ${g.home} vs ${g.away}  ${stars}${soon}`);
    }
    lines.push(BR);
  }

  lines.push(SEP);
  lines.push(`📊  <b>${totalImportant}</b> jogos Tier 1-2 hoje  ·  Top <b>${topGames.length}</b> destacados`);
  lines.push(`🔔  <b>⭐⭐</b> = 2 clubes top  ·  <b>🔥</b> = rivalidade  ·  <b>🔔</b> = começa em ≤3h`);
  lines.push(`🤖  <i>Betting Analysis Squad</i>`);

  return lines.join('\n');
}

// ── Pipeline principal ─────────────────────────────────────────────────────────
async function run() {
  const now  = Date.now();
  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(now + 86_400_000).toISOString().split('T')[0];

  const dateStr = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).toUpperCase();

  if (!DRY && !FORCE && _radarSentToday()) {
    console.log(chalk.yellow(`  ⚠️  Radar já enviado hoje — ignorando para evitar duplicata.`));
    console.log(chalk.gray('     Use --force para forçar reenvio.'));
    return [];
  }

  console.log(chalk.bold.cyan('\n══════════════════════════════════════════════'));
  console.log(chalk.bold.cyan('  🎯 GAMES RADAR — Jogos Importantes do Dia'));
  console.log(chalk.bold.cyan('══════════════════════════════════════════════\n'));

  // ── Coleta partidas das próximas 24h ────────────────────────────────────────
  const allEvents = [];
  for (const date of [today, tomorrow]) {
    try {
      const { data } = await axios.get(
        `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${date}`,
        { headers: SOFA_HEADERS, timeout: 10_000 }
      );
      allEvents.push(...(data?.events || []));
    } catch (e) {
      console.warn(chalk.yellow(`  ⚠️  SofaScore ${date}: ${e.message}`));
    }
  }

  // ── Filtra ligas relevantes e pré-calcula score ──────────────────────────────
  const cutoff = now + 24 * 3_600_000;
  const scored = [];

  for (const e of allEvents) {
    const lid = e.tournament?.uniqueTournament?.id;
    const info = LEAGUE_SCORE[lid];
    if (!info) continue;

    const kickoff    = (e.startTimestamp || 0) * 1000;
    if (kickoff > cutoff) continue;               // fora da janela de 24h
    if (e.status?.type === 'finished') continue;  // já terminou

    const home         = e.homeTeam?.name || '?';
    const away         = e.awayTeam?.name || '?';
    const hoursUntil   = (kickoff - now) / 3_600_000;
    const total        = scoreMatch(e, info);
    const prestigeBonus = (PRESTIGE_CLUBS.has(home) ? 3 : 0) + (PRESTIGE_CLUBS.has(away) ? 3 : 0);
    const rivalry      = isRivalry(home, away);

    scored.push({
      sofascore_id: e.id,
      home,
      away,
      match:        `${home} vs ${away}`,
      league:       info.name,
      flag:         info.flag,
      tier:         info.tier,
      hora:         fmtHora(e.startTimestamp),
      kickoff,
      hoursUntil:   Math.round(hoursUntil * 10) / 10,
      score:        total,
      prestigeBonus,
      rivalry,
      status:       e.status?.type,
    });
  }

  // Deduplica por sofascore_id
  const seen    = new Set();
  const unique  = scored.filter(g => { if (seen.has(g.sofascore_id)) return false; seen.add(g.sofascore_id); return true; });

  // Ordena: score DESC, depois horário ASC
  unique.sort((a, b) => b.score - a.score || a.kickoff - b.kickoff);

  const topGames = unique.slice(0, TOP_N);

  // Reagrupa top games por liga (mantendo ordem de score dentro de cada liga)
  const byLeagueOrdered = {};
  for (const g of topGames) {
    if (!byLeagueOrdered[g.league]) byLeagueOrdered[g.league] = [];
    byLeagueOrdered[g.league].push(g);
  }
  // Reordena dentro de cada liga por horário
  for (const key of Object.keys(byLeagueOrdered)) {
    byLeagueOrdered[key].sort((a, b) => a.kickoff - b.kickoff);
  }
  // Reconstrói lista ordenada: liga com maior score médio primeiro
  const leagueScores = Object.entries(byLeagueOrdered).map(([league, games]) => ({
    league,
    avgScore: games.reduce((s, g) => s + g.score, 0) / games.length,
    games,
  })).sort((a, b) => b.avgScore - a.avgScore);

  const finalTop = leagueScores.flatMap(l => l.games);

  // ── Console summary ─────────────────────────────────────────────────────────
  console.log(chalk.bold(`📊 ${unique.length} jogos Tier 1-2 encontrados → Top ${finalTop.length} selecionados\n`));
  for (const g of finalTop) {
    const rival = g.rivalry ? chalk.red('🔥') : ' ';
    const star  = g.prestigeBonus >= 6 ? chalk.yellow('⭐⭐') : g.prestigeBonus >= 3 ? chalk.yellow('⭐') : '  ';
    const soon  = g.hoursUntil >= 0 && g.hoursUntil <= 3 ? chalk.green(' 🔔') : '';
    console.log(`  ${g.hora} | ${chalk.cyan(g.league.padEnd(26))} | ${rival} ${star} ${g.match}${soon} [${g.score}pts]`);
  }
  console.log('');

  // ── Exporta JSON para prelive-superodds-now.js consumir ─────────────────────
  if (AS_JSON || !DRY) {
    try {
      mkdirSync(join(ROOT, 'data'), { recursive: true });
      writeFileSync(
        join(ROOT, 'data/radar-today.json'),
        JSON.stringify({
          generated_at: new Date().toISOString(),
          total_important: unique.length,
          top_games: finalTop.map(g => ({
            sofascore_id: g.sofascore_id,
            match:        g.match,
            league:       g.league,
            tier:         g.tier,
            hora:         g.hora,
            kickoff:      g.kickoff,
            score:        g.score,
            rivalry:      g.rivalry,
          })),
        }, null, 2)
      );
      console.log(chalk.green('  💾 data/radar-today.json salvo\n'));
    } catch (e) {
      console.warn(chalk.yellow(`  ⚠️  Não foi possível salvar JSON: ${e.message}`));
    }
  }

  // ── Envia ao Telegram ────────────────────────────────────────────────────────
  if (!DRY) {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn(chalk.yellow('  ⚠️  Telegram não configurado — só console'));
      return finalTop;
    }

    const msg = buildMessage(finalTop, unique.length, dateStr);

    try {
      const res = await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id:                  chatId,
          text:                     msg,
          parse_mode:               'HTML',
          disable_web_page_preview: true,
        }
      );
      if (res.data?.ok) {
        console.log(chalk.green('  ✅ Radar enviado ao Telegram (msg_id: ' + res.data.result.message_id + ')'));
        _markRadarSent();
      }
    } catch (e) {
      console.warn(chalk.red('  ❌ Telegram falhou: ' + e.message));
    }
  } else {
    console.log(chalk.gray('  [DRY] Mensagem NÃO enviada ao Telegram\n'));
    const msg = buildMessage(finalTop, unique.length, dateStr);
    console.log(chalk.gray('─── Prévia da mensagem ───'));
    console.log(msg.replace(/<[^>]+>/g, ''));
    console.log(chalk.gray('─────────────────────────\n'));
  }

  return finalTop;
}

run().catch(e => {
  console.error(chalk.red('Erro fatal:', e.message));
  process.exit(1);
});
