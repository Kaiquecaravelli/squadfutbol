#!/usr/bin/env node
/**
 * coletar-escanteios-dia.js — Coleta dados reais de escanteios via SofaScore
 *
 * Busca as estatísticas dos 17 jogos de 19/04/2026, compara com as estimativas
 * contextuais geradas na auditoria e registra amostras reais no PIE.
 *
 * Uso:
 *   node scripts/coletar-escanteios-dia.js          → data de hoje
 *   node scripts/coletar-escanteios-dia.js 2026-04-19 → data específica
 *   npm run corners-dia
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const HEADERS   = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Jogos da auditoria de corners (19/04/2026) ────────────────────────────────
// Estimativas contextuais do Módulo 2 da auditoria vs dados reais
const JOGOS_AUDITORIA = [
  { id: 'J01', home: 'juventus',       away: 'bologna',          liga: 'Serie A Italiana',    esc_est_min: 7,  esc_est_max: 9  },
  { id: 'J02', home: 'genoa',          away: 'pisa',             liga: 'Serie B Italiana',    esc_est_min: 8,  esc_est_max: 11 },
  { id: 'J03', home: 'ac milan',       away: 'verona',           liga: 'Serie A Italiana',    esc_est_min: 5,  esc_est_max: 8  },
  { id: 'J04', home: 'aston villa',    away: 'sunderland',       liga: 'FA Cup',               esc_est_min: 13, esc_est_max: 16 },
  { id: 'J05', home: 'lyon',           away: 'psg',              liga: 'Ligue 1',             esc_est_min: 9,  esc_est_max: 12 },
  { id: 'J06', home: 'rennes',         away: 'strasbourg',       liga: 'Ligue 1',             esc_est_min: 10, esc_est_max: 14 },
  { id: 'J07', home: 'brest',          away: 'nantes',           liga: 'Ligue 1',             esc_est_min: 6,  esc_est_max: 8  },
  { id: 'J08', home: 'monaco',         away: 'auxerre',          liga: 'Ligue 1',             esc_est_min: 10, esc_est_max: 13 },
  { id: 'J09', home: 'athletic club',  away: 'novorizontino',    liga: 'Brasileirão Série B', esc_est_min: 8,  esc_est_max: 10 },
  { id: 'J10', home: 'fortaleza',      away: 'criciuma',         liga: 'Brasileirão Série A', esc_est_min: 9,  esc_est_max: 12 },
  { id: 'J11', home: 'goias',          away: 'cuiaba',           liga: 'Brasileirão Série B', esc_est_min: 5,  esc_est_max: 8  },
  { id: 'J12', home: 'ceara',          away: 'londrina',         liga: 'Brasileirão Série C', esc_est_min: 4,  esc_est_max: 7  },
  { id: 'J13', home: 'atletico-go',    away: 'botafogo-sp',      liga: 'Brasileirão Série B', esc_est_min: 4,  esc_est_max: 7  },
  { id: 'J14', home: 'palmeiras',      away: 'athletico-pr',     liga: 'Brasileirão Série A', esc_est_min: 7,  esc_est_max: 9  },
  { id: 'J15', home: 'fluminense',     away: 'santos',           liga: 'Brasileirão Série A', esc_est_min: 8,  esc_est_max: 11 },
  { id: 'J16', home: 'internacional',  away: 'mirassol',         liga: 'Brasileirão Série B', esc_est_min: 7,  esc_est_max: 10 },
  { id: 'J17', home: 'atletico-mg',    away: 'coritiba',         liga: 'Brasileirão Série A', esc_est_min: 8,  esc_est_max: 12 },
];

// ── SofaScore helpers ─────────────────────────────────────────────────────────
async function sofaGet(path, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(`${SOFA_BASE}${path}`, { headers: HEADERS, timeout: 20_000 });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) {
        const delay = i * 6000;
        process.stdout.write(` [429 rate-limit, aguardando ${delay/1000}s]`);
        await sleep(delay);
        continue;
      }
      if (i === retries) throw err;
      await sleep(i * 2000);
    }
  }
}

async function fetchCorners(eventId) {
  try {
    const data = await sofaGet(`/event/${eventId}/statistics`);
    const all  = data.statistics?.find(s => s.period === 'ALL');
    if (!all) return null;

    for (const group of all.groups || []) {
      for (const item of group.statisticsItems || []) {
        const nome = (item.name || '').toLowerCase();
        if (nome.includes('corner')) {
          return {
            home:  parseInt(item.home) || 0,
            away:  parseInt(item.away) || 0,
            total: (parseInt(item.home) || 0) + (parseInt(item.away) || 0),
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Matching fuzzy entre nomes de times ──────────────────────────────────────
function normalizar(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchTeam(sofaNome, buscaNome) {
  const sn = normalizar(sofaNome);
  const bn = normalizar(buscaNome);
  if (sn === bn) return true;
  if (sn.includes(bn) || bn.includes(sn)) return true;
  // Partials: pega a primeira palavra de cada
  const [sw] = sn.split(' ');
  const [bw] = bn.split(' ');
  return sw.length > 3 && bw.length > 3 && sw === bw;
}

function encontrarJogoAuditoria(evento) {
  const homeNome = evento.homeTeam?.name || '';
  const awayNome = evento.awayTeam?.name || '';
  return JOGOS_AUDITORIA.find(j =>
    matchTeam(homeNome, j.home) && matchTeam(awayNome, j.away)
  );
}

// ── Coleta principal ──────────────────────────────────────────────────────────
async function main() {
  const dataAlvo = process.argv[2] || new Date().toISOString().slice(0, 10);
  console.log('\n' + '═'.repeat(65));
  console.log(`  COLETA DE ESCANTEIOS — ${dataAlvo}`);
  console.log('═'.repeat(65));
  console.log('Fonte: SofaScore API — dados reais pós-jogo\n');

  // Busca todos os eventos do dia no SofaScore
  let eventos = [];
  try {
    const data = await sofaGet(`/sport/football/scheduled-events/${dataAlvo}`);
    eventos = data.events || [];
    console.log(`SofaScore: ${eventos.length} eventos encontrados para ${dataAlvo}`);
  } catch (err) {
    console.error('Erro ao buscar eventos SofaScore:', err.message);
    process.exit(1);
  }

  const resultados = [];
  let encontrados  = 0;
  let naoEncontrados = [];

  for (const jogo of JOGOS_AUDITORIA) {
    const evento = eventos.find(e => encontrarJogoAuditoria(e) === jogo);

    if (!evento) {
      naoEncontrados.push(jogo);
      resultados.push({ ...jogo, encontrado: false, corners: null });
      console.log(`  ${jogo.id} ${jogo.home.padEnd(18)} vs ${jogo.away.padEnd(18)} → NÃO ENCONTRADO`);
      continue;
    }

    // Verifica se o jogo terminou
    const status = evento.status?.type || '';
    if (!['finished', 'ended', 'canceled'].includes(status)) {
      const score = `${evento.homeScore?.current ?? '?'}-${evento.awayScore?.current ?? '?'}`;
      console.log(`  ${jogo.id} ${jogo.home.padEnd(18)} vs ${jogo.away.padEnd(18)} → EM ANDAMENTO (${score})`);
      resultados.push({ ...jogo, encontrado: true, ao_vivo: true, corners: null, evento_id: evento.id });
      await sleep(800);
      continue;
    }

    // Busca estatísticas
    process.stdout.write(`  ${jogo.id} ${jogo.home.padEnd(18)} vs ${jogo.away.padEnd(18)} → `);
    const corners = await fetchCorners(evento.id);
    const scoreH  = evento.homeScore?.current ?? '?';
    const scoreA  = evento.awayScore?.current ?? '?';

    if (corners) {
      encontrados++;
      const total      = corners.total;
      const estOk      = total >= jogo.esc_est_min && total <= jogo.esc_est_max;
      const estimStr   = `[est. ${jogo.esc_est_min}-${jogo.esc_est_max}]`;
      const validacao  = estOk ? '✅ OK' : (total < jogo.esc_est_min ? '⬇️ ABAIXO' : '⬆️ ACIMA');
      console.log(`${scoreH}-${scoreA} · Esc: ${corners.home}+${corners.away}=${total} ${estimStr} ${validacao}`);
      resultados.push({
        ...jogo,
        encontrado:     true,
        evento_id:      evento.id,
        placar_real:    `${scoreH}-${scoreA}`,
        corners_home:   corners.home,
        corners_away:   corners.away,
        corners_total:  total,
        over_65:        total >= 7,
        over_75:        total >= 8,
        over_85:        total >= 9,
        over_95:        total >= 10,
        est_acertou:    estOk,
        est_delta:      total - Math.round((jogo.esc_est_min + jogo.esc_est_max) / 2),
        corners_real:   corners,
      });
    } else {
      console.log(`${scoreH}-${scoreA} · Sem dados de escanteios`);
      resultados.push({ ...jogo, encontrado: true, evento_id: evento.id, corners: null });
    }

    await sleep(1200); // rate limit
  }

  // ── Análise dos resultados ──────────────────────────────────────────────────
  const comDados = resultados.filter(r => r.corners_total != null);

  console.log('\n' + '─'.repeat(65));
  console.log('  ANÁLISE CONSOLIDADA DE ESCANTEIOS');
  console.log('─'.repeat(65));

  if (comDados.length === 0) {
    console.log('Sem dados reais coletados. Verifique se os jogos já terminaram.');
    console.log(`Tente novamente amanhã: node scripts/coletar-escanteios-dia.js ${dataAlvo}`);
    process.exit(0);
  }

  const media    = comDados.reduce((a, r) => a + r.corners_total, 0) / comDados.length;
  const o65pct   = (comDados.filter(r => r.over_65).length / comDados.length * 100).toFixed(0);
  const o75pct   = (comDados.filter(r => r.over_75).length / comDados.length * 100).toFixed(0);
  const o85pct   = (comDados.filter(r => r.over_85).length / comDados.length * 100).toFixed(0);
  const o95pct   = (comDados.filter(r => r.over_95).length / comDados.length * 100).toFixed(0);
  const estAcertos = comDados.filter(r => r.est_acertou).length;

  console.log(`Jogos com dados:    ${comDados.length} / ${JOGOS_AUDITORIA.length}`);
  console.log(`Média escanteios:   ${media.toFixed(1)} / jogo`);
  console.log(`Over 6.5 (≥7):      ${o65pct}%  (${comDados.filter(r => r.over_65).length}/${comDados.length})`);
  console.log(`Over 7.5 (≥8):      ${o75pct}%  (${comDados.filter(r => r.over_75).length}/${comDados.length})`);
  console.log(`Over 8.5 (≥9):      ${o85pct}%  (${comDados.filter(r => r.over_85).length}/${comDados.length})`);
  console.log(`Over 9.5 (≥10):     ${o95pct}%  (${comDados.filter(r => r.over_95).length}/${comDados.length})`);
  console.log(`Estimativas OK:     ${estAcertos}/${comDados.length} (${(estAcertos/comDados.length*100).toFixed(0)}%)`);

  // Tabela por liga
  const porLiga = {};
  for (const r of comDados) {
    porLiga[r.liga] = porLiga[r.liga] || { total: 0, jogos: 0, o65: 0, o75: 0 };
    porLiga[r.liga].total += r.corners_total;
    porLiga[r.liga].jogos++;
    if (r.over_65) porLiga[r.liga].o65++;
    if (r.over_75) porLiga[r.liga].o75++;
  }

  console.log('\n  Por liga:');
  for (const [liga, d] of Object.entries(porLiga)) {
    const med = (d.total / d.jogos).toFixed(1);
    console.log(`    ${liga.padEnd(26)} média ${med.padStart(4)} · O6.5: ${d.o65}/${d.jogos} · O7.5: ${d.o75}/${d.jogos}`);
  }

  // ── Registra amostras reais no pie-lessons.json ──────────────────────────────
  const lessonsPath = join(ROOT, 'data/pie-lessons.json');
  const lessons     = JSON.parse(readFileSync(lessonsPath, 'utf8'));
  const ts          = new Date().toISOString();
  const novas       = [];

  for (const r of comDados) {
    for (const [mkt, linha] of [['Over Corners 6.5', 7], ['Over Corners 7.5', 8], ['Over Corners 8.5', 9]]) {
      novas.push({
        type:           'HISTORICO_CORNERS_REAL',
        mercado:        mkt,
        match:          `${r.home} vs ${r.away}`,
        competition:    r.liga,
        data:           dataAlvo,
        ts,
        placar_real:    r.placar_real,
        corners_home:   r.corners_home,
        corners_away:   r.corners_away,
        corners_total:  r.corners_total,
        acertou:        r.corners_total >= linha,
        estimativa_min: r.esc_est_min,
        estimativa_max: r.esc_est_max,
        est_acertou:    r.est_acertou,
        source:         'AUDITORIA_CORNERS_19042026',
        fonte:          'sofascore',
      });
    }
  }

  const totalAntes = lessons.length;
  lessons.push(...novas);
  writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2), 'utf8');
  console.log(`\n  PIE: +${novas.length} amostras reais (${comDados.length} jogos × 3 mercados) → ${lessons.length} total`);

  // ── Validação padrões C_E1-C_E10 ────────────────────────────────────────────
  console.log('\n  Validação estimativas C_E1-C_E10:');
  const deltasMed = comDados.map(r => r.est_delta);
  const deltaMedio = deltasMed.reduce((a, b) => a + b, 0) / deltasMed.length;
  const deltaMedioAbs = deltasMed.map(Math.abs).reduce((a, b) => a + b, 0) / deltasMed.length;
  console.log(`    Desvio médio estimativa vs real: ${deltaMedio > 0 ? '+' : ''}${deltaMedio.toFixed(1)} escanteios`);
  console.log(`    Erro absoluto médio:             ${deltaMedioAbs.toFixed(1)} escanteios`);
  console.log(`    Estimativas dentro do intervalo: ${estAcertos}/${comDados.length}`);

  if (deltaMedio > 1.5) {
    console.log('    ⚠️  Estimativas sistematicamente ABAIXO — considerar aumentar lambda base');
  } else if (deltaMedio < -1.5) {
    console.log('    ⚠️  Estimativas sistematicamente ACIMA — considerar reduzir lambda base');
  } else {
    console.log('    ✅ Estimativas calibradas — sem desvio sistemático relevante');
  }

  // ── Não encontrados ──────────────────────────────────────────────────────────
  if (naoEncontrados.length > 0) {
    console.log(`\n  Não encontrados no SofaScore (${naoEncontrados.length}):`);
    for (const j of naoEncontrados) {
      console.log(`    ${j.id} ${j.home} vs ${j.away} (${j.liga})`);
    }
    console.log('  Dica: nomes podem diferir entre Flashscore e SofaScore. Ajustar JOGOS_AUDITORIA se necessário.');
  }

  // ── Notificação Telegram ─────────────────────────────────────────────────────
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (token && chatId && comDados.length > 0) {
    const linhas = [
      `📐 CORNERS REAL — ${dataAlvo}`,
      `════════════════════════════════`,
      `${comDados.length}/${JOGOS_AUDITORIA.length} jogos coletados`,
      `Media: ${media.toFixed(1)} esc/jogo`,
      `Over 6.5: ${o65pct}% · Over 7.5: ${o75pct}%`,
      `Over 8.5: ${o85pct}% · Over 9.5: ${o95pct}%`,
      `Estimativas OK: ${estAcertos}/${comDados.length} (${(estAcertos/comDados.length*100).toFixed(0)}%)`,
      `Erro absoluto medio: ${deltaMedioAbs.toFixed(1)} escanteios`,
      `+${novas.length} amostras -> PIE total: ${lessons.length}`,
    ];
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        { chat_id: chatId, text: linhas.join('\n') },
        { timeout: 10_000 },
      );
      console.log('\n  Notificação Telegram enviada ✅');
    } catch (e) {
      console.log('\n  Telegram:', e.message);
    }
  }

  console.log('\n' + '═'.repeat(65) + '\n');
}

main().catch(err => {
  console.error('\n❌ ERRO:', err.message);
  process.exit(1);
});
