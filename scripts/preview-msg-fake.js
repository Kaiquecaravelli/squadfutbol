/**
 * preview-msg-fake.js — renderiza preview com dados fixos, sem chamar APIs
 */
import 'dotenv/config';
import { buildParlayOptions } from '../src/agents/parlay-builder.js';

// Dados de exemplo (reproduzem o que foi enviado pelo script anterior)
const legs = [
  {
    match:         'Genoa vs Sassuolo',
    competition:   'Serie A',
    match_date:    '2026-04-12T19:45:00.000Z',
    match_time:    '16:45',
    market:        'Over 1.5',
    market_type:   'Total de Gols',
    recomendacao:  'APOSTAR',
    probabilidade: 81,
    confianca:     76,
    odds:          1.35,
    house:         'Superbet',
    confidence:    79,
    ev:            0,
    pie_accuracy:  null,
    superbet_url:  'https://superbet.bet.br/odds/futebol/genoa-x-sassuolo-11703301',
  },
  {
    match:         'Fortuna Sittard vs NAC Breda',
    competition:   'Eredivisie',
    match_date:    '2026-04-12T14:30:00.000Z',
    match_time:    '11:30',
    market:        'Over 1.5',
    market_type:   'Total de Gols',
    recomendacao:  'APOSTAR',
    probabilidade: 81,
    confianca:     76,
    odds:          1.35,
    house:         'Superbet',
    confidence:    79,
    ev:            0,
    pie_accuracy:  null,
    superbet_url:  'https://superbet.bet.br/odds/futebol/fortuna-sittard-x-nac-breda-14053798',
  },
  {
    match:         'Nottingham Forest vs Aston Villa',
    competition:   'Premier League',
    match_date:    '2026-04-12T16:00:00.000Z',
    match_time:    '13:00',
    market:        'BTTS',
    market_type:   'Ambas Marcam',
    recomendacao:  'SIM',
    probabilidade: 73,
    confianca:     72,
    odds:          1.75,
    house:         'Superbet',
    confidence:    72,
    ev:            0,
    pie_accuracy:  null,
    superbet_url:  'https://superbet.bet.br/odds/futebol/nottingham-forest-x-aston-villa-14025025',
  },
];

const parlayOptions = buildParlayOptions(legs);

// ── Formatadores locais (espelho do telegram.js) ──────────────────────────────
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

// ── Renderiza todos os tiers ──────────────────────────────────────────────────
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
    : { label: 'Alto',  icon: '🔴' };

  const lines = [
    `${emoji}  SUPER ODDS · ${tierName.toUpperCase()}`,
    SEP_HEAVY,
    '',
    `💎  ODDS COMBINADAS :  ${topCombo.combined_odds}×`,
    `🔒  Prob (Probabilidade) :  ${confComb}%`,
    '',
    `📋  SELEÇÕES  (${topCombo.leg_count} pernas)`,
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
    const matchStr = homeR && awayR ? `${homeR.trim()}  vs  ${awayR.trim()}` : (leg.match || '?');
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
  lines.push(SEP_LIGHT);
  lines.push(`⚠️  Apostas combinadas são de alto risco. Gerencie bem sua banca.`);
  lines.push('', SEP_HEAVY);
  lines.push(`🤖  Betting Analysis Squad  ·  ${tierName}`);

  console.log('\n' + '═'.repeat(58));
  console.log('  PRÉVIA TELEGRAM — ' + tierName);
  console.log('═'.repeat(58));
  console.log(lines.join('\n'));
  console.log('═'.repeat(58) + '\n');
  tiersSent++;
}
