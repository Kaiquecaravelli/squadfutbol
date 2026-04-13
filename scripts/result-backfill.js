/**
 * result-backfill.js — Fechamento do Loop de Feedback do PIE
 *
 * Problema atual: 89/90 predições no pie.json não têm resultado registrado.
 * O PIE não aprende porque `saveResult()` nunca é chamado automaticamente.
 *
 * Este script:
 *  1. Carrega todas as predições pendentes (sem result_id)
 *  2. Busca o resultado real via SofaScore API (quando sofascore_id disponível)
 *  3. Determina acerto/erro por mercado
 *  4. Chama saveResult() → atualiza calibração PIE
 *
 * Uso:
 *   node scripts/result-backfill.js              → processa todas pendentes
 *   node scripts/result-backfill.js --dry-run    → mostra o que faria, sem salvar
 *   node scripts/result-backfill.js --days=3     → só predições dos últimos N dias
 *   node scripts/result-backfill.js --limit=20   → processa no máximo N predições
 */

import axios from 'axios';
import { getPendingPredictions, saveResult } from '../src/pie/pie-storage.js';

// ── Configuração ───────────────────────────────────────────────────────────────
const SOFASCORE_BASE = 'https://api.sofascore.com/api/v1';
const DELAY_MS       = 1200;  // respeita rate-limit do SofaScore
const HEADERS        = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json',
  'Referer':         'https://www.sofascore.com/',
};

// ── Determinação de acerto por mercado ────────────────────────────────────────
/**
 * Retorna true/false/null (null = não verificável sem o placar).
 * @param {string} market
 * @param {string} recommendation  — string retornada pelo agente
 * @param {object} score           — { home: number, away: number }
 */
function determineOutcome(market, recommendation, score, stats = null) {
  if (score.home == null || score.away == null) return null;

  const totalGoals = score.home + score.away;
  const rec        = String(recommendation || '').toUpperCase();

  switch (market) {
    case 'Over 0.5':  return totalGoals > 0;
    case 'Over 1.5':  return totalGoals > 1;
    case 'Over 2.5':  return totalGoals > 2;
    case 'Over 3.5':  return totalGoals > 3;
    case 'Over 4.5':  return totalGoals > 4;
    case 'Under 1.5': return totalGoals < 2;
    case 'Under 2.5': return totalGoals < 3;
    case 'Under 3.5': return totalGoals < 4;

    case 'BTTS':
      // rec pode ser 'SIM'/'NÃO'/'YES'/'NO' ou 'APOSTAR'
      if (rec === 'NÃO' || rec === 'NO' || rec === 'UNDER' || rec === 'NAO') {
        return !(score.home > 0 && score.away > 0); // apostou que NÃO
      }
      return score.home > 0 && score.away > 0; // apostou que SIM

    case 'Home Win': case '1':
      return score.home > score.away;

    case 'Away Win': case '2':
      return score.away > score.home;

    case 'Draw': case 'X':
      return score.home === score.away;

    case '1X': case 'Dupla Chance 1X':
      return score.home >= score.away; // home win or draw

    case 'X2': case 'Dupla Chance X2':
      return score.away >= score.home; // away win or draw

    case '12': case 'Dupla Chance 12':
      return score.home !== score.away; // any team wins

    case 'Resultado Final':
      // Inferir da recomendação: '1', 'X', '2'
      if (rec.includes('1') && !rec.includes('X') && !rec.includes('2')) return score.home > score.away;
      if (rec.includes('X')) return score.home === score.away;
      if (rec.includes('2') && !rec.includes('1')) return score.away > score.home;
      return null;

    case 'Over Corners':
    case 'Over Corners 6.5':
    case 'Over Corners 7.5':
    case 'Over Corners 8.5':
    case 'Over Corners 9.5':
    case 'Over Corners 10.5': {
      if (!stats) return null;
      // SofaScore reporta 'corner_kicks' com home/away
      const ck = stats['corner_kicks'] || stats['corners'] || stats['escanteios'];
      if (!ck) return null;
      const totalCorners = (ck.home || 0) + (ck.away || 0);
      const threshold = parseFloat(market.match(/[\d.]+/)?.[0] || 8);
      return totalCorners > threshold;
    }

    case 'Over YC 2.5': case 'Over YC 3.5': case 'Over YC 4.5':
    case 'YC 2.5': case 'YC 3.5': case 'YC 4.5':
    case 'Cartões': {
      if (!stats) return null;
      const yc = stats['yellow_cards'] || stats['cartoes_amarelos'] || stats['yellow_card'];
      if (!yc) return null;
      const totalYC = (yc.home || 0) + (yc.away || 0);
      const threshold = parseFloat(market.match(/[\d.]+/)?.[0] || 2);
      return totalYC > threshold;
    }

    default:
      return null;
  }
}

// ── Busca resultado no SofaScore (placar + stats: escanteios, cartões) ────────
async function fetchEventResult(sofascoreId) {
  try {
    const url = `${SOFASCORE_BASE}/event/${sofascoreId}`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000 });
    const event = data?.event;

    if (!event) return null;

    const status = event.status?.type;
    if (status !== 'finished') return { status, score: null };

    const home = event.homeScore?.current ?? event.homeScore?.normaltime;
    const away = event.awayScore?.current ?? event.awayScore?.normaltime;

    if (home == null || away == null) return { status, score: null };

    // Busca stats para escanteios e cartões
    let stats = null;
    try {
      const sUrl = `${SOFASCORE_BASE}/event/${sofascoreId}/statistics`;
      const sRes = await axios.get(sUrl, { headers: HEADERS, timeout: 6000 });
      const periods = sRes.data?.statistics || [];
      // Usa "ALL" period ou o último período disponível
      const allPeriod = periods.find(p => p.period === 'ALL') || periods[periods.length - 1];
      if (allPeriod?.groups) {
        stats = {};
        for (const group of allPeriod.groups) {
          for (const item of group.statisticsItems || []) {
            const key = item.name?.toLowerCase().replace(/\s+/g, '_');
            if (key) {
              stats[key] = {
                home: parseFloat(item.home) || 0,
                away: parseFloat(item.away) || 0,
              };
            }
          }
        }
      }
    } catch { /* stats são opcionais */ }

    return {
      status:    'finished',
      score:     { home: Number(home), away: Number(away) },
      stats,
      matchName: `${event.homeTeam?.name} ${home}-${away} ${event.awayTeam?.name}`,
    };
  } catch {
    return null;
  }
}

// ── Tenta buscar por data/times quando não há sofascore_id ───────────────────
async function trySearchByName(matchName, matchDate) {
  if (!matchName || !matchDate) return null;
  try {
    const date = matchDate.split('T')[0]; // YYYY-MM-DD
    const url  = `${SOFASCORE_BASE}/sport/football/scheduled-events/${date}`;
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000 });
    const events = data?.events || [];

    const [homeSearch, awaySearch] = matchName.split(/\s+vs\s+/i);
    if (!homeSearch || !awaySearch) return null;

    // Busca pelo nome mais próximo (match parcial insensível a maiúsculas)
    const found = events.find(e => {
      const hn = e.homeTeam?.name?.toLowerCase() || '';
      const an = e.awayTeam?.name?.toLowerCase() || '';
      return (
        hn.includes(homeSearch.toLowerCase().slice(0, 6)) &&
        an.includes(awaySearch.toLowerCase().slice(0, 6))
      );
    });

    if (!found) return null;

    const status = found.status?.type;
    if (status !== 'finished') return { status, score: null };

    const home = found.homeScore?.current;
    const away = found.awayScore?.current;
    if (home == null || away == null) return null;

    return {
      status:    'finished',
      score:     { home: Number(home), away: Number(away) },
      matchName: `${found.homeTeam?.name} ${home}-${away} ${found.awayTeam?.name}`,
      sofascoreId: found.id,
    };
  } catch {
    return null;
  }
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function runBackfill({ dryRun = false, daysBack = 30, limit = 100 } = {}) {
  console.log('\n' + '═'.repeat(64));
  console.log('  🔄 PIE Result Backfill — Fechamento do Loop de Feedback');
  console.log(`  Modo: ${dryRun ? 'DRY-RUN (sem salvar)' : 'REAL'} | Janela: ${daysBack} dias | Limite: ${limit}`);
  console.log('═'.repeat(64) + '\n');

  const pending = getPendingPredictions();

  // Filtra por janela de tempo
  const cutoff = Date.now() - daysBack * 86_400_000;
  const inWindow = pending.filter(p => {
    const created = new Date(p.created_at || p.match_date || 0).getTime();
    return created >= cutoff;
  });

  const toProcess = inWindow.slice(0, limit);

  console.log(`📋 Predições pendentes: ${pending.length} total | ${inWindow.length} nos últimos ${daysBack} dias | processando ${toProcess.length}\n`);

  let found = 0, skipped = 0, errors = 0;
  const stats = { acertos: 0, erros: 0, naoVerificaveis: 0 };

  for (let i = 0; i < toProcess.length; i++) {
    const pred = toProcess[i];
    const label = pred.match_name || pred.match_id;

    process.stdout.write(`  [${i + 1}/${toProcess.length}] ${label.substring(0, 45).padEnd(45)} `);

    // Tenta buscar resultado
    let result = null;

    if (pred.sofascore_id) {
      result = await fetchEventResult(pred.sofascore_id);
    }

    if (!result) {
      // Tenta busca por nome/data como fallback
      result = await trySearchByName(pred.match_name, pred.match_date);
    }

    if (!result) {
      console.log('⚠️  SofaScore sem resposta');
      errors++;
      await delay(DELAY_MS);
      continue;
    }

    if (result.status !== 'finished' || !result.score) {
      console.log(`⏳ Jogo ainda não encerrado (${result.status || '?'})`);
      skipped++;
      await delay(DELAY_MS);
      continue;
    }

    const { score } = result;
    const placarStr = `${score.home}-${score.away}`;

    // Determina acerto por mercado
    const marketOutcomes = pred.markets.map(m => ({
      market:         m.market,
      recommendation: m.recommendation,
      probabilidade:  m.probabilidade,
      acertou:        determineOutcome(m.market, m.recommendation, score, result.stats),
    }));

    const verificaveis = marketOutcomes.filter(o => o.acertou !== null);
    const acertos      = verificaveis.filter(o => o.acertou === true).length;
    const naoVerif     = marketOutcomes.filter(o => o.acertou === null).length;

    stats.acertos       += acertos;
    stats.erros         += verificaveis.filter(o => o.acertou === false).length;
    stats.naoVerificaveis += naoVerif;

    const resumo = verificaveis.map(o =>
      `${o.market}:${o.acertou ? '✅' : '❌'}`
    ).join(' ') || (naoVerif > 0 ? 'não verificável' : '?');

    console.log(`${placarStr}  →  ${resumo}`);

    if (!dryRun) {
      try {
        saveResult({
          predictionId:   pred.id,
          matchName:      pred.match_name,
          placarReal:     placarStr,
          marketOutcomes,
          competition:    pred.competition || '',
        });
        found++;
      } catch (err) {
        console.error(`     ❌ Erro ao salvar: ${err.message}`);
        errors++;
      }
    } else {
      found++;
    }

    await delay(DELAY_MS);
  }

  // Resumo final
  const total = found + skipped + errors;
  console.log('\n' + '─'.repeat(64));
  console.log(`  ✅ Finalizados:        ${found}`);
  console.log(`  ⏳ Não encerrados:     ${skipped}`);
  console.log(`  ⚠️  Erros:             ${errors}`);
  console.log(`  📊 Acertos registrados: ${stats.acertos}`);
  console.log(`  📊 Erros registrados:   ${stats.erros}`);
  console.log(`  📊 Não verificáveis:    ${stats.naoVerificaveis}`);

  if (found > 0 && !dryRun) {
    console.log('\n  🧠 PIE calibração atualizada com dados reais!');
    console.log('  💡 Execute `npm run pie-status` para ver o novo status.');
  }

  console.log('═'.repeat(64) + '\n');
  return { found, skipped, errors, stats };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('result-backfill.js')) {
  import('dotenv/config').catch(() => {});

  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const daysArg = args.find(a => a.startsWith('--days='));
  const limArg  = args.find(a => a.startsWith('--limit='));

  await runBackfill({
    dryRun,
    daysBack: daysArg ? parseInt(daysArg.split('=')[1]) : 30,
    limit:    limArg  ? parseInt(limArg.split('=')[1])  : 100,
  });
}

export { runBackfill };
