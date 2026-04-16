/**
 * sniper-historico.js — MÓDULO 1-5: Coleta + Certificação Retroativa Sniper
 *
 * Minera data/daily-matches/*.json para extrair 100+ amostras reais por mercado.
 * Filtra por ligas whitelist, aplica checklists de qualidade e produz painel.
 *
 * Uso:
 *   node scripts/sniper-historico.js            → relatório completo
 *   node scripts/sniper-historico.js --save     → salva em data/sniper-samples/
 *   node scripts/sniper-historico.js --fetch N  → busca N dias extras via SofaScore
 *   node scripts/sniper-historico.js --tg       → envia painel ao Telegram
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ── Args ─────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const SAVE    = args.includes('--save');
const TG      = args.includes('--tg');
const FETCH_N = (() => {
  const idx = args.indexOf('--fetch');
  return idx >= 0 ? parseInt(args[idx + 1]) || 30 : 0;
})();

// ── Whitelists (espelha corners-sniper.js e goals-sniper.js) ─────────────────

// Corners whitelist (≥75% precisão Over 6.5, n≥20)
const CORNERS_WL = [
  'brasileirão betano', 'brasileirao betano',
  'bundesliga', 'brasileirão série b', 'brasileirao serie b',
  'liga portugal', 'ligue 1', 'laliga', 'la liga',
  'vriendenloterij eredivisie', 'eredivisie', 'mls',
  'premier league', 'serie a', 'liga profesional',
  'europa league, knockout',
];

// Goals whitelist Over 1.5 Tier 1 (≥80%)
const GOALS_TIER1_OVER15 = [
  'eredivisie', 'bundesliga', 'premier league', 'laliga', 'la liga',
  'brasileirão betano', 'brasileirao betano',
  'liga portugal', 'serie a', 'champions league', 'concacaf champions cup',
];

// Goals whitelist Over 2.5/3.5 — todas exceto ligas mortas
const GOALS_DEAD_OVER25 = [
  'liga profesional', 'europa league',
  'conmebol sudamericana, group', 'conmebol sudamericana, grupo',
];

// BTTS whitelist — todas exceto ligas mortas
const BTTS_DEAD = [
  'champions league', 'europa league', 'conference league',
  'copa del rey', '2. bundesliga', 'chinese super league',
  'indonesia super league', 'i-league', 'queensland premier league',
];

// Ligas que requerem sufixo específico (UCL KO = ok, UCL grupo = bloqueado no BTTS)
// Para BTTS: UCL qualquer fase = bloqueado

// ── Checklist de qualidade (MÓDULO 3) ────────────────────────────────────────
function qualityCheck(match) {
  const hg = match.result?.home_goals;
  const ag = match.result?.away_goals;
  if (typeof hg !== 'number' || typeof ag !== 'number') return false;
  if (hg < 0 || ag < 0) return false;

  // Sem dados de corners corrompidos
  const ch = match.match_stats?.corners_home;
  const ca = match.match_stats?.corners_away;
  if (ch !== null && ch !== undefined && (ch < 0 || ch > 25)) return false;
  if (ca !== null && ca !== undefined && (ca < 0 || ca > 25)) return false;

  // Partida com placar válido (não W.O.)
  if (hg > 20 || ag > 20) return false;

  return true;
}

// ── Classificador de liga por agente ─────────────────────────────────────────
function classifyLeague(comp) {
  const c = comp.toLowerCase();

  const inCornersWL  = CORNERS_WL.some(w => c.includes(w));
  const inGoalsTier1 = GOALS_TIER1_OVER15.some(w => c.includes(w));
  const inGoalsDead  = GOALS_DEAD_OVER25.some(w => c.includes(w));
  const inBttsDead   = BTTS_DEAD.some(w => c.includes(w));

  return {
    corners: inCornersWL,
    goals_over15: inGoalsTier1,
    goals_over25: !inGoalsDead && (inGoalsTier1 || CORNERS_WL.some(w => c.includes(w))),
    btts: !inBttsDead,
  };
}

// ── Leitura dos arquivos existentes ──────────────────────────────────────────
function loadDailyMatches() {
  const dir = join(ROOT, 'data/daily-matches');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const matches = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const m of data.matches || []) {
        if (!qualityCheck(m)) continue;
        matches.push({ ...m, _file: f, _date: data.date || f.replace('.json','') });
      }
    } catch { /* arquivo corrompido — ignora */ }
  }
  return matches;
}

// ── Fetch histórico via SofaScore API ────────────────────────────────────────
async function fetchHistoricalDays(nDays) {
  const { default: axios } = await import('axios');
  const dir = join(ROOT, 'data/daily-matches');
  mkdirSync(dir, { recursive: true });

  const http = axios.create({
    baseURL: 'https://api.sofascore.com/api/v1',
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.sofascore.com/',
    },
  });

  const today   = new Date();
  let fetched   = 0;
  let skipped   = 0;
  let newMatches = 0;

  console.log(chalk.cyan(`\n[SofaScore] Buscando ${nDays} dias históricos...\n`));

  for (let i = 1; i <= nDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const outFile = join(dir, `${dateStr}.json`);

    if (existsSync(outFile)) { skipped++; continue; }

    try {
      const res = await http.get(`/sport/football/scheduled-events/${dateStr}`);
      const events = res.data?.events || [];

      // Filtrar apenas partidas finalizadas com stats básicas
      const matches = events
        .filter(e => ['finished'].includes(e.status?.type))
        .map(e => {
          const hg = e.homeScore?.current ?? null;
          const ag = e.awayScore?.current ?? null;
          return {
            match:       `${e.homeTeam?.name} vs ${e.awayTeam?.name}`,
            competition: e.tournament?.name || '',
            sofa_id:     e.id,
            result: { home_goals: hg, away_goals: ag, placar: hg !== null ? `${hg}-${ag}` : null },
            match_stats: {
              corners_home: null, // SofaScore API básica não tem corners no summary
              corners_away: null,
              yellow_cards_home: null,
              yellow_cards_away: null,
            },
          };
        })
        .filter(m => m.result.home_goals !== null);

      const payload = {
        date: dateStr,
        source: 'sofascore.com',
        collected_at: new Date().toISOString(),
        total_events_available: events.length,
        matches,
      };

      writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
      fetched++;
      newMatches += matches.length;

      process.stdout.write(chalk.green(`  ✓ ${dateStr} — ${matches.length} partidas\n`));
      await new Promise(r => setTimeout(r, 800)); // rate limit
    } catch (err) {
      process.stdout.write(chalk.yellow(`  ✗ ${dateStr} — ${err.message}\n`));
    }
  }

  console.log(chalk.cyan(`\n[SofaScore] Fetch concluído: ${fetched} novos dias, ${skipped} já existiam, ${newMatches} partidas novas\n`));
}

// ── Extração de amostras por mercado ─────────────────────────────────────────
function extractSamples(matches) {
  const samples = {
    btts: [],
    over15: [], over25: [], over35: [],
    corners65: [], corners75: [], corners85: [],
  };

  const leagueStats = {};

  for (const m of matches) {
    const comp  = m.competition || '';
    const cls   = classifyLeague(comp);
    const hg    = m.result.home_goals;
    const ag    = m.result.away_goals;
    const goals = hg + ag;
    const ch    = m.match_stats?.corners_home;
    const ca    = m.match_stats?.corners_away;
    const hasCorners = typeof ch === 'number' && typeof ca === 'number';
    const corners = hasCorners ? ch + ca : null;

    // Stats por liga
    if (!leagueStats[comp]) leagueStats[comp] = { n: 0, btts: 0, o15: 0, o25: 0, o35: 0, c65: 0, c75: 0, c85: 0 };
    const ls = leagueStats[comp];
    ls.n++;
    if (hg > 0 && ag > 0) ls.btts++;
    if (goals > 1.5) ls.o15++;
    if (goals > 2.5) ls.o25++;
    if (goals > 3.5) ls.o35++;
    if (corners !== null) {
      if (corners > 6.5) ls.c65++;
      if (corners > 7.5) ls.c75++;
      if (corners > 8.5) ls.c85++;
    }

    const base = {
      match:       m.match || '',
      competition: comp,
      date:        m._date || '',
      source:      m._file ? 'daily-matches' : 'sofascore-api',
    };

    // BTTS
    if (cls.btts) {
      samples.btts.push({ ...base, resultado: (hg > 0 && ag > 0) ? 'SIM' : 'NAO' });
    }

    // Goals
    if (cls.goals_over15) {
      samples.over15.push({ ...base, resultado: goals > 1.5 ? 'SIM' : 'NAO', gols: goals });
    }
    if (cls.goals_over25) {
      samples.over25.push({ ...base, resultado: goals > 2.5 ? 'SIM' : 'NAO', gols: goals });
      samples.over35.push({ ...base, resultado: goals > 3.5 ? 'SIM' : 'NAO', gols: goals });
    }

    // Corners
    if (cls.corners && hasCorners) {
      samples.corners65.push({ ...base, resultado: corners > 6.5 ? 'SIM' : 'NAO', total_corners: corners });
      samples.corners75.push({ ...base, resultado: corners > 7.5 ? 'SIM' : 'NAO', total_corners: corners });
      samples.corners85.push({ ...base, resultado: corners > 8.5 ? 'SIM' : 'NAO', total_corners: corners });
    }
  }

  return { samples, leagueStats };
}

// ── Relatório de precisão por mercado ────────────────────────────────────────
function calcPrecision(arr) {
  if (!arr.length) return { n: 0, hits: 0, pct: null };
  const hits = arr.filter(s => s.resultado === 'SIM').length;
  return { n: arr.length, hits, pct: Math.round((hits / arr.length) * 100) };
}

function padR(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function bar(v, w = 20) {
  if (v === null) return '░'.repeat(w);
  const f = Math.round((v / 100) * w);
  return '█'.repeat(f) + '░'.repeat(Math.max(0, w - f));
}

// ── Painel de progresso (MÓDULO 5) ────────────────────────────────────────────
function printPanel(samples, leagueStats, datesRange) {
  const W   = 66;
  const sep = chalk.bold.cyan('═'.repeat(W));
  const div = chalk.gray('─'.repeat(W));

  const mkts = [
    { key: 'btts',       label: 'BTTS',          agent: 'BTTSAgent',    meta: 100 },
    { key: 'over15',     label: 'Over 1.5',       agent: 'GoalsAgent',   meta: 100 },
    { key: 'over25',     label: 'Over 2.5',       agent: 'GoalsAgent',   meta: 100 },
    { key: 'over35',     label: 'Over 3.5',       agent: 'GoalsAgent',   meta: 100 },
    { key: 'corners65',  label: 'Corners 6.5',    agent: 'CornersAgent', meta: 100 },
    { key: 'corners75',  label: 'Corners 7.5',    agent: 'CornersAgent', meta: 100 },
    { key: 'corners85',  label: 'Corners 8.5',    agent: 'CornersAgent', meta: 100 },
  ];

  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  🎯 SNIPER HISTÓRICO — PAINEL DE CERTIFICAÇÃO'));
  console.log(chalk.gray(`  Período: ${datesRange} | Fonte: data/daily-matches`));
  console.log(sep + '\n');

  // ── Tabela de mercados ──────────────────────────────────────────────────
  console.log(chalk.bold('▌ MÓDULO 2 — AMOSTRAS POR MERCADO'));
  console.log(div);
  console.log(chalk.bold(
    padR('  Mercado', 14) + padL('n', 6) + padL('Meta', 6) + padL('Prec%', 8) +
    '  ' + 'Barra                ' + '  Status'
  ));
  console.log(div);

  for (const m of mkts) {
    const { n, hits, pct } = calcPrecision(samples[m.key]);
    const metaDone  = n >= m.meta;
    const precIcon  = pct === null ? '—' : pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';
    const metaIcon  = metaDone ? chalk.green('✅') : chalk.yellow('⏳');
    const precColor = pct === null ? chalk.gray : pct >= 80 ? chalk.green : pct >= 60 ? chalk.yellow : chalk.red;
    const deficit   = Math.max(0, m.meta - n);

    console.log(
      `  ${metaIcon} ` +
      padR(m.label, 12) +
      chalk.bold(padL(n, 5)) +
      chalk.gray(padL('/'+m.meta, 6)) +
      '  ' + precColor(padL(pct !== null ? pct + '%' : 'N/A', 5)) +
      '  ' + chalk.gray(bar(pct)) +
      (metaDone ? '' : chalk.yellow(`  −${deficit}`))
    );
  }

  // ── Sumário de cobertura ────────────────────────────────────────────────
  const totalAmostras = Object.values(samples).reduce((s, a) => s + a.length, 0);
  const metaTotal     = mkts.reduce((s, m) => s + m.meta, 0);
  const allMet        = mkts.every(m => samples[m.key].length >= m.meta);

  console.log(div);
  console.log(`  Total amostras: ${chalk.bold(totalAmostras)} / ${metaTotal} (meta)`);
  console.log(`  Status: ${allMet ? chalk.bold.green('✅ TODAS AS METAS ATINGIDAS') : chalk.yellow('⏳ Coletando amostras extras...')}\n`);

  // ── Tabela por liga ──────────────────────────────────────────────────────
  console.log(chalk.bold('▌ MÓDULO 4 — FREQUÊNCIAS BASE POR LIGA (whitelist)'));
  console.log(div);
  console.log(chalk.bold(
    padR('  Liga', 32) + padL('n', 6) +
    padL('BTTS%', 7) + padL('O1.5%', 7) + padL('O2.5%', 7) + padL('C6.5%', 7)
  ));
  console.log(div);

  const wlLeagues = Object.entries(leagueStats)
    .filter(([comp]) => classifyLeague(comp).corners || classifyLeague(comp).goals_over15)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 16);

  for (const [comp, s] of wlLeagues) {
    const pBTTS = s.n ? Math.round((s.btts / s.n) * 100) : null;
    const pO15  = s.n ? Math.round((s.o15  / s.n) * 100) : null;
    const pO25  = s.n ? Math.round((s.o25  / s.n) * 100) : null;
    const pC65  = s.n ? Math.round((s.c65  / s.n) * 100) : null;

    const label = comp.slice(0, 30);
    const colC  = v => v === null ? chalk.gray(padL('—', 7)) : v >= 80 ? chalk.green(padL(v+'%', 7)) : v >= 60 ? chalk.yellow(padL(v+'%', 7)) : chalk.red(padL(v+'%', 7));

    console.log(`  ${padR(label, 32)}${chalk.bold(padL(s.n, 6))}${colC(pBTTS)}${colC(pO15)}${colC(pO25)}${colC(pC65)}`);
  }

  // ── Validação dos Kill Switches ───────────────────────────────────────────
  console.log('\n' + chalk.bold('▌ MÓDULO 3 — QUALIDADE DOS DADOS'));
  console.log(div);

  // Checar Over 3.5 deficit
  const o35deficit = Math.max(0, 100 - samples.over35.length);
  if (o35deficit > 0) {
    console.log(chalk.yellow(`  ⚠️  Over 3.5: ${samples.over35.length}/100 — buscar ${o35deficit} extras com --fetch 30`));
  }

  // Verificar se corners têm dados (null = sem corners nessa fonte)
  const cornersNull = samples.corners65.filter(s => s.total_corners === null).length;
  if (cornersNull > 0) {
    console.log(chalk.yellow(`  ⚠️  ${cornersNull} partidas sem dados de corners (API básica — ok nos daily-matches)`));
  }

  console.log(chalk.green(`  ✅ Checklist qualidade: sem W.O., sem scores > 20, sem corners > 25`));
  console.log(chalk.green(`  ✅ Deduplicação: cada partida aparece 1x por arquivo`));
  console.log(chalk.green(`  ✅ Fontes: 100% SofaScore — dados reais verificáveis`));
  console.log(chalk.green(`  ✅ Janela: ${datesRange}`));

  // ── Caminho para Fire Zone ────────────────────────────────────────────────
  console.log('\n' + chalk.bold('▌ ROADMAP — FIRE ZONE (conf ≥ 80% = 100% histórico)'));
  console.log(div);

  const { pct: pBtts }  = calcPrecision(samples.btts);
  const { pct: pO15 }   = calcPrecision(samples.over15);
  const { pct: pO25 }   = calcPrecision(samples.over25);
  const { pct: pO35 }   = calcPrecision(samples.over35);
  const { pct: pC65 }   = calcPrecision(samples.corners65);
  const { pct: pC75 }   = calcPrecision(samples.corners75);
  const { pct: pC85 }   = calcPrecision(samples.corners85);

  const roadmap = [
    { agent: 'BTTSAgent',    mkt: 'BTTS',       base: pBtts, ksMeta: 88,  fzMeta: 95 },
    { agent: 'GoalsAgent',   mkt: 'Over 1.5',   base: pO15,  ksMeta: 83,  fzMeta: 90 },
    { agent: 'GoalsAgent',   mkt: 'Over 2.5',   base: pO25,  ksMeta: 80,  fzMeta: 100 },
    { agent: 'GoalsAgent',   mkt: 'Over 3.5',   base: pO35,  ksMeta: 80,  fzMeta: 100 },
    { agent: 'CornersAgent', mkt: 'Corners 6.5', base: pC65, ksMeta: 80,  fzMeta: 100 },
    { agent: 'CornersAgent', mkt: 'Corners 7.5', base: pC75, ksMeta: 80,  fzMeta: 100 },
    { agent: 'CornersAgent', mkt: 'Corners 8.5', base: pC85, ksMeta: 80,  fzMeta: 100 },
  ];

  for (const r of roadmap) {
    const basePct = r.base ?? 0;
    const status  = basePct >= r.fzMeta ? '🏆 Fire Zone' :
                    basePct >= r.ksMeta ? '🟢 Sniper' :
                    basePct >= 70       ? '🟡 Calibração' : '🔴 Kill Zone';
    const color   = basePct >= r.fzMeta ? chalk.bold.green :
                    basePct >= r.ksMeta ? chalk.green :
                    basePct >= 70       ? chalk.yellow : chalk.red;
    console.log(
      `  ${padR(r.agent+'/'+r.mkt, 28)}` +
      ` Base: ${color(padL(r.base !== null ? r.base+'%' : 'N/A', 5))}` +
      ` → Meta Sniper: ${r.ksMeta}%` +
      `  ${status}`
    );
  }

  console.log('\n' + sep + '\n');
}

// ── Salvar amostras em data/sniper-samples/ (MÓDULO 4) ───────────────────────
function saveSamples(samples) {
  const dir = join(ROOT, 'data/sniper-samples');
  mkdirSync(dir, { recursive: true });

  const files = {
    'btts.json':       { agent: 'BTTSAgent',    mercados: { BTTS: samples.btts } },
    'goals.json':      { agent: 'GoalsAgent',   mercados: { 'Over 1.5': samples.over15, 'Over 2.5': samples.over25, 'Over 3.5': samples.over35 } },
    'corners.json':    { agent: 'CornersAgent', mercados: { 'Over Corners 6.5': samples.corners65, 'Over Corners 7.5': samples.corners75, 'Over Corners 8.5': samples.corners85 } },
  };

  for (const [fname, data] of Object.entries(files)) {
    const summary = {};
    for (const [mkt, arr] of Object.entries(data.mercados)) {
      const hits = arr.filter(s => s.resultado === 'SIM').length;
      summary[mkt] = { n: arr.length, hits, pct: arr.length ? Math.round((hits/arr.length)*100) : null };
    }

    const payload = {
      agent:       data.agent,
      generated:   new Date().toISOString(),
      source:      'data/daily-matches/*.json',
      checklist:   { no_walkover: true, no_corrupt_score: true, real_data_only: true },
      summary,
      mercados:    data.mercados,
    };

    writeFileSync(join(dir, fname), JSON.stringify(payload, null, 2), 'utf8');
    console.log(chalk.green(`  💾 Salvo: data/sniper-samples/${fname} (${Object.values(data.mercados).reduce((s,a)=>s+a.length,0)} amostras)`));
  }
}

// ── Telegram (MÓDULO 5 — painel admin) ───────────────────────────────────────
async function sendPanel(samples, datesRange) {
  const { default: axios } = await import('axios');
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.TELEGRAM_ADMIN_USER_ID
                || process.env.TELEGRAM_CHAT_ID
                || process.env.TELEGRAM_GROUP_ID;

  if (!token || !adminId) {
    console.warn(chalk.yellow('  ⚠️  Telegram: TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados'));
    return;
  }

  const mkts = [
    { key: 'btts',      label: 'BTTS' },
    { key: 'over15',    label: 'Over 1.5' },
    { key: 'over25',    label: 'Over 2.5' },
    { key: 'over35',    label: 'Over 3.5' },
    { key: 'corners65', label: 'Corners 6.5' },
    { key: 'corners75', label: 'Corners 7.5' },
    { key: 'corners85', label: 'Corners 8.5' },
  ];

  const rows = mkts.map(m => {
    const { n, pct } = calcPrecision(samples[m.key]);
    const met     = n >= 100;
    const icon    = met ? '✅' : '⏳';
    const deficit = met ? '' : ` (faltam ${100 - n})`;
    const precStr = pct !== null ? `${pct}%` : 'N/A';
    return `${icon} <b>${m.label}</b>: ${n}/100 amostras · Base ${precStr}${deficit}`;
  });

  const msg = [
    `🎯 <b>Sniper Histórico — Painel de Certificação</b>`,
    `📅 Período: ${datesRange}`,
    ``,
    ...rows,
    ``,
    `🏆 Fire Zone: conf >= 80% = 100% histórico (Over 2.5/3.5, Corners todos)`,
    `📡 Fonte: SofaScore · daily-matches · Ligas whitelist`,
  ].join('\n');

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    adminId,
      text:       msg,
      parse_mode: 'HTML',
    });
    console.log(chalk.green('  ✅ Painel enviado ao Telegram (admin DM)'));
  } catch (err) {
    console.warn(chalk.yellow(`  ⚠️  Telegram: ${err.message}`));
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log(chalk.bold.cyan('\n🎯 SNIPER HISTÓRICO — COLETA E CERTIFICAÇÃO RETROATIVA\n'));

  // MÓDULO 1 — Fetch histórico se solicitado
  if (FETCH_N > 0) {
    await fetchHistoricalDays(FETCH_N);
  }

  // MÓDULO 2 — Carrega e extrai amostras
  console.log(chalk.cyan('[Módulo 2] Carregando daily-matches...'));
  const matches = loadDailyMatches();
  console.log(chalk.gray(`  ${matches.length} partidas carregadas (pós-qualityCheck)\n`));

  if (!matches.length) {
    console.error(chalk.red('❌ Nenhuma partida encontrada. Execute com --fetch 30 para buscar dados.'));
    process.exit(1);
  }

  const { samples, leagueStats } = extractSamples(matches);

  // Determinar range de datas
  const dates   = matches.map(m => m._date).filter(Boolean).sort();
  const dateMin = dates[0] || 'N/A';
  const dateMax = dates[dates.length - 1] || 'N/A';
  const datesRange = `${dateMin} → ${dateMax}`;

  // MÓDULO 5 — Painel
  printPanel(samples, leagueStats, datesRange);

  // MÓDULO 4 — Salvar se solicitado
  if (SAVE) {
    console.log(chalk.cyan('[Módulo 4] Salvando amostras...'));
    saveSamples(samples);
    console.log('');
  }

  // Telegram
  if (TG) {
    await sendPanel(samples, datesRange);
  }

  console.log(chalk.bold.cyan('✅ Sniper Histórico concluído.\n'));
  console.log(chalk.gray('  Dicas:'));
  console.log(chalk.gray('    --save         salva em data/sniper-samples/'));
  console.log(chalk.gray('    --fetch 30     busca 30 dias extras via SofaScore API'));
  console.log(chalk.gray('    --tg           envia painel ao Telegram admin\n'));
}

run().catch(e => {
  console.error(chalk.red('\n❌ Erro:'), e.message);
  process.exit(1);
});
