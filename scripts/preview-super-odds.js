/**
 * preview-super-odds.js — renderiza o texto da mensagem Super Odds sem enviar ao Telegram
 */
import 'dotenv/config';
import { getSofascoreMatches, getSofascoreMatchDetails } from '../src/scrapers/sofascore.js';
import { GoalsAgent } from '../squads/betting-analysis/market-agents/GoalsAgent.js';
import { BTTSAgent }  from '../squads/betting-analysis/market-agents/BTTSAgent.js';
import { buildParlayOptions } from '../src/agents/parlay-builder.js';
import { getSuperbetEventMap, findUrlInEventMap } from '../src/scrapers/superbet.js';
import { loadDB } from '../src/pie/pie-storage.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const todayStr    = new Date().toISOString().slice(0, 10);
const tomorrowStr = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const [t, tm] = await Promise.all([
  getSofascoreMatches(todayStr).catch(() => []),
  getSofascoreMatches(tomorrowStr).catch(() => []),
]);
const pool = [...t, ...tm].slice(0, 14);

const eventMap = await getSuperbetEventMap();
const filtered = pool.filter(m => findUrlInEventMap(eventMap, m.home_team, m.away_team));
const db = (() => { try { return loadDB(); } catch { return null; } })();
const legs = [];

for (const sm of filtered.slice(0, 10)) {
  try {
    const md = await getSofascoreMatchDetails(sm).catch(() => null);
    if (!md) continue;
    let result = null;
    for (const agent of [new GoalsAgent(), new BTTSAgent()]) {
      try {
        const r = await agent.analyze(md);
        if (r && r.probabilidade >= 70 && r.confianca >= 68) { result = r; break; }
      } catch {}
      await sleep(600);
    }
    if (!result) continue;
    const market = result.mercado || 'Over 2.5';
    const odds   = result.odds_minima_recomendada || 1.75;
    const score  = Math.round((result.probabilidade * 0.6) + (result.confianca * 0.4));
    legs.push({
      match:         md.match,
      competition:   sm.competition || '?',
      match_date:    sm.match_date  || null,
      match_time:    sm.match_time  || null,
      market,
      market_type:   result.market  || market,
      recomendacao:  result.recomendacao || 'APOSTAR',
      probabilidade: result.probabilidade ?? score,
      confianca:     result.confianca     ?? score,
      odds:          typeof odds === 'number' ? odds : parseFloat(odds) || 1.75,
      house:         'Superbet',
      confidence:    score,
      ev:            result.ev || 0,
      pie_accuracy:  null,
      superbet_url:  findUrlInEventMap(eventMap, sm.home_team, sm.away_team),
    });
  } catch {}
}

if (!legs.length) { console.log('Sem pernas'); process.exit(0); }

const parlayOptions = buildParlayOptions(legs);

// ── Replica a lógica de formatação de notifySuperOddsParlay ───────────────────
const SEP_HEAVY = '━━━━━━━━━━━━━━━━';
const SEP_LIGHT = '────────────────';
const NUMBERS   = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
const TIER_EMOJIS = { 'Seguro': '🛡️', 'Acumulador': '⚡', 'Super Odds': '🚀' };

const formatTime = d => { try { return new Date(d).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'}); } catch { return String(d); } };
const formatDate = d => { try { return new Date(d).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',timeZone:'America/Sao_Paulo'}); } catch { return String(d); } };

function _formatRec(mercado, rec) {
  const mu = (mercado || '').toUpperCase();
  const ru = (rec     || '').toUpperCase();
  if (mu.includes('BTTS') || mu.includes('AMBAS') || mu.includes('MARCAM')) {
    if (ru === 'SIM' || ru === 'APOSTAR') return 'Sim';
    if (ru === 'NAO' || ru === 'NÃO') return 'Não';
    return rec;
  }
  const linha = mercado.match(/\d+\.?\d*/)?.[0];
  const linhaFmt = linha ? (linha.includes('.') ? linha : `${linha}.5`) : '';
  const isOver = ru.includes('OVER') || ru.includes('MAIS') || ru === 'SIM' || ru === 'APOSTAR';
  return linhaFmt ? `${isOver ? 'Over' : 'Under'} ${linhaFmt}` : (isOver ? 'Over' : 'Under');
}

function _buildBetLabel(marketType, mercado, recomendacao) {
  const mt  = (marketType   || '').toUpperCase();
  const mc  = (mercado      || '').toUpperCase();
  const rec = (recomendacao || 'APOSTAR').toUpperCase();
  if (mt.includes('BTTS') || mc.includes('BTTS') || mt.includes('AMBAS') || mt.includes('MARCAM')) {
    return `Ambas Marcam  ${(rec === 'SIM' || rec === 'APOSTAR') ? 'Sim' : 'Não'}`;
  }
  if (mt.includes('ESCANTEIO') || mt.includes('CORNER')) return `Escanteios  ${_formatRec(mercado, recomendacao)}`;
  return `Gols  ${_formatRec(mercado, recomendacao)}`;
}

let tiersSent = 0;
for (const [tierName, tierData] of Object.entries(parlayOptions.tiers || {})) {
  if (tiersSent >= 1) break;
  if (!tierData?.available || !tierData.best?.length) continue;
  const topCombo = tierData.best[0];
  if (!topCombo?.legs?.length) continue;
  const confComb = topCombo.confidence ?? 0;
  const confGate = tierName === 'Seguro' ? 50 : tierName === 'Acumulador' ? 30 : 20;
  if (confComb < confGate) continue;

  const emoji = TIER_EMOJIS[tierName] || '🎰';
  const risco = tierName === 'Seguro'
    ? { label: 'Baixo', icon: '🟢' }
    : tierName === 'Acumulador'
    ? { label: 'Médio', icon: '🟡' }
    : { label: 'Alto', icon: '🔴' };

  const lines = [
    `${emoji}  SUPER  ODDS  ·  ${tierName.toUpperCase()}`,
    SEP_HEAVY,
    '',
    `💎  ODDS COMBINADAS :  ${topCombo.combined_odds}×`,
    `🔒  Prob (Probabilidade) :  ${confComb}%`,
    '',
    `📋  SELEÇÕES  (${topCombo.leg_count}  pernas)`,
    SEP_LIGHT,
  ];

  for (let i = 0; i < topCombo.legs.length; i++) {
    const leg      = topCombo.legs[i];
    const num      = NUMBERS[i] || `${i + 1}.`;
    const legScore = leg.confidence    ?? 0;
    const legProb  = leg.probabilidade ?? legScore;
    const legConf  = leg.confianca     ?? legScore;
    const confIcon = legScore >= 80 ? '🟢' : legScore >= 70 ? '🟡' : '🔴';
    const [homeR, awayR] = (leg.match || '').split(' vs ');
    const matchStr = homeR && awayR
      ? `${homeR.trim()}  vs  ${awayR.trim()}`
      : (leg.match || '?');
    const legDateTime = leg.match_date
      ? `⏰ ${formatTime(leg.match_date)}  📅 ${formatDate(leg.match_date)}`
      : leg.match_time ? `⏰ ${leg.match_time}` : null;
    const betLabel = _buildBetLabel(leg.market_type || leg.market, leg.market, leg.recomendacao || 'APOSTAR');

    lines.push(`${num}  ${matchStr}${legDateTime ? `   ${legDateTime}` : ''}`);
    lines.push(`       ${confIcon}  ${betLabel}`);
    lines.push(`       📊 Prob: ${legProb}%   🔒 Conf: ${legConf}%`);
    if (leg.superbet_url) lines.push(`       🔗 ${leg.superbet_url}`);
    lines.push('');
  }

  const roiPct = Math.round((topCombo.combined_odds - 1) * 100);
  lines.push(SEP_LIGHT);
  lines.push(`📈  Multiplicador :  ${topCombo.combined_odds}×   ROI (Retorno) :  +${roiPct}%`);
  lines.push(`${risco.icon}  Risco :  ${risco.label}  —  ${confComb}% de chance de todas as pernas acertarem`);
  lines.push('');
  if (tierName === 'Super Odds') {
    lines.push(`⚠️  Alavancagem máxima  —  alto retorno potencial, alto risco`);
    lines.push(`     Prob real de acerto :  ${topCombo.combined_prob}%`);
    lines.push('');
  }
  lines.push(SEP_LIGHT);
  lines.push(`⚠️ Apostas combinadas são de alto risco. Gerencie bem sua banca.`);
  lines.push('', SEP_HEAVY);
  lines.push(`🤖  Betting Analysis Squad  ·  ${tierName}`);

  console.log('\n' + '═'.repeat(55));
  console.log('  PRÉVIA DA MENSAGEM TELEGRAM — ' + tierName);
  console.log('═'.repeat(55));
  console.log(lines.join('\n'));
  console.log('═'.repeat(55) + '\n');
  tiersSent++;
}
