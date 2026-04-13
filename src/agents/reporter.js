import chalk from 'chalk';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { saveToObsidian } from '../utils/obsidian.js';
import { loadDB } from '../pie/pie-storage.js';

export function generateReport({ matchData, newsAnalysis, tacticalAnalysis, quantAnalysis, oddsAnalysis, riskAssessment, sharpBonus = 0, scorePrediction = null }) {
  console.log(`📋 [Reporter] Gerando relatório final...`);

  const topBet = quantAnalysis.value_bets?.[0];
  const confidenceScore = calcConfidenceScore({ tacticalAnalysis, quantAnalysis, newsAnalysis, oddsAnalysis, riskAssessment, topBet, sharpBonus });
  const recommendation = getRecommendation(confidenceScore);

  const report = buildReportText({
    matchData, newsAnalysis, tacticalAnalysis, quantAnalysis,
    oddsAnalysis, riskAssessment, confidenceScore, recommendation, topBet, scorePrediction,
  });

  // Exibir no terminal
  console.log('\n' + report.terminal);

  // Salvar em arquivo local (./reports/)
  saveReport(matchData.match, report.markdown);

  // Salvar no Obsidian vault (se configurado)
  const obsidianPath = saveToObsidian({
    matchData,
    report: report.markdown,
    confidenceScore,
    recommendation,
    topBet,
    riskAssessment,
    quantAnalysis,
  });

  return {
    matchData,
    confidence_score: confidenceScore,
    recommendation,
    top_bet: topBet,
    value_bets: quantAnalysis.value_bets || [],  // todos os value bets para parlay-builder
    risk: riskAssessment,
    report_text: report.markdown,
    obsidian_path: obsidianPath,
    score_prediction: scorePrediction,
    // xG do modelo: lambda Poisson = gols esperados por time nesta partida
    xg_home: quantAnalysis?.lambda_home ?? null,
    xg_away: quantAnalysis?.lambda_away ?? null,
  };
}

// Exportado para uso no pipeline (Sharp Gate calcula score preliminar)
export function calcConfidenceScore({ tacticalAnalysis, quantAnalysis, newsAnalysis, oddsAnalysis, riskAssessment, topBet = null, sharpBonus = 0 }) {
  let score = 0;

  // Quant: 35% — usa EV se disponível, senão a vantagem probabilística bruta
  const topEV = quantAnalysis.value_bets?.[0]?.ev || 0;
  if (topEV > 0) {
    score += Math.min(35, topEV * 200);
  } else {
    const probs   = quantAnalysis.probabilities || {};
    const maxProb = Math.max(probs.home_win || 0, probs.away_win || 0, probs.over_2_5 || 0, probs.btts || 0);
    const modelConf = quantAnalysis.model_confidence || 0.5;
    score += Math.min(20, maxProb * 25 * modelConf);
  }

  // Tactical: 25% — penalidade proporcional: -3 por flag (antes: -5 flat)
  const tactEdge  = tacticalAnalysis.tactical_edge !== 'neutral' ? 20 : 10;
  const flagCount = tacticalAnalysis.risk_flags?.length || 0;
  score += tactEdge + (flagCount > 0 ? -(flagCount * 3) : 5);

  // News: 15%
  const homeImpact = newsAnalysis?.home?.impact_score || 0;
  const awayImpact = newsAnalysis?.away?.impact_score || 0;
  const newsNet = Math.max(-15, Math.min(15, homeImpact - awayImpact));
  score += 8 + newsNet * 0.3;

  // Odds movement: steam detectado = 25 pts (antes: 15)
  const sentiment = oddsAnalysis?.market_sentiment;
  if (sentiment === 'sharp_money_home') score += 25;
  else if (sentiment === 'neutral') score += 8;
  else score += 3;

  // Risk level: 10%
  const risk = riskAssessment?.risk_level;
  if (risk === 'LOW') score += 10;
  else if (risk === 'MEDIUM') score += 6;
  else score += 2;

  // PIE factor: ±8 pts baseado na acurácia histórica do mercado
  try {
    const db = loadDB();
    score += _calcPIEFactor(topBet, db);
  } catch { /* PIE indisponível — ignora silenciosamente */ }

  // Sharp Agents bonus (injetado pelo pipeline quando score borderline)
  score += sharpBonus;

  return Math.min(100, Math.max(0, Math.round(score)));
}

function _calcPIEFactor(topBet, db) {
  if (!topBet?.market) return 0;
  const cal = db.calibration?.[topBet.market];
  if (!cal || cal.total < 10) return 0;
  const accuracy = (cal.hits / cal.total) * 100;
  // Cada ponto acima de 75% vale +0.4 pts, máx ±8
  return Math.max(-8, Math.min(8, Math.round((accuracy - 75) * 0.4)));
}

function getRecommendation(score) {
  if (score >= 80) return { label: '✅ APOSTAR', color: 'green', action: 'BET' };
  if (score >= 60) return { label: '⚡ CONSIDERAR', color: 'yellow', action: 'CONSIDER' };
  if (score >= 40) return { label: '⚠️  AGUARDAR', color: 'yellow', action: 'WAIT' };
  return { label: '❌ IGNORAR', color: 'red', action: 'SKIP' };
}

function buildReportText({ matchData, newsAnalysis, tacticalAnalysis, quantAnalysis, oddsAnalysis, riskAssessment, confidenceScore, recommendation, topBet, scorePrediction = null }) {
  const bar = buildProgressBar(confidenceScore);
  const date = new Date(matchData.date).toLocaleString('pt-BR');

  const terminalLines = [
    chalk.bold.blue('╔══════════════════════════════════════════════════════╗'),
    chalk.bold.blue(`║  ⚽ ANÁLISE DE APOSTA`),
    chalk.bold.blue(`║  ${matchData.match}`),
    chalk.bold.blue(`║  📅 ${date}  |  🏆 ${matchData.competition}`),
    chalk.bold.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.bold(`║  🎯 RECOMENDAÇÃO FINAL`),
    chalk[recommendation.color](`║  ${recommendation.label}`),
    topBet ? `║  Mercado: ${topBet.market}  |  Odds: ${topBet.odds} (${topBet.house})` : '║  Nenhum value bet encontrado',
    riskAssessment?.stake ? `║  Stake sugerida: R$ ${riskAssessment.stake} (${riskAssessment.stake_pct}% da banca)` : '',
    `║  Confiança: ${confidenceScore}/100  ${bar}`,
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.cyan(`║  📊 ANÁLISE QUANTITATIVA`),
    `║  Prob. Real: ${pctStr(quantAnalysis.probabilities?.home_win)} / ${pctStr(quantAnalysis.probabilities?.draw)} / ${pctStr(quantAnalysis.probabilities?.away_win)}`,
    `║  BTTS: ${pctStr(quantAnalysis.probabilities?.btts)}  |  Over 2.5: ${pctStr(quantAnalysis.probabilities?.over_2_5)}`,
    topBet ? `║  EV: ${topBet.ev_pct}  |  ${topBet.rating}` : '',
    quantAnalysis.probabilistic_scores ? buildScoreLine(quantAnalysis.probabilistic_scores) : '',
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.magenta(`║  ♟️  ANÁLISE TÁTICA`),
    `║  Edge: ${tacticalAnalysis.tactical_edge?.toUpperCase()}  |  ${tacticalAnalysis.key_factors?.[0] || ''}`,
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.yellow(`║  📰 NOTÍCIAS`),
    `║  ${newsAnalysis?.home?.team}: ${newsAnalysis?.home?.impact_score > 0 ? '+' : ''}${newsAnalysis?.home?.impact_score} pts (${newsAnalysis?.home?.sentiment})`,
    `║  ${newsAnalysis?.away?.team}: ${newsAnalysis?.away?.impact_score > 0 ? '+' : ''}${newsAnalysis?.away?.impact_score} pts (${newsAnalysis?.away?.sentiment})`,
    newsAnalysis?.home?.key_headlines?.[0] ? `║  📌 ${newsAnalysis.home.key_headlines[0].title?.slice(0, 55)}` : '',
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.cyan(`║  📈 MOVIMENTO DE ODDS`),
    oddsAnalysis?.alerts?.length ? `║  ${oddsAnalysis.alerts[0]}` : '║  Sem movimentos relevantes',
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    ...buildArielTerminalLines(scorePrediction),
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.green(`║  🛡️  GESTÃO DE RISCO`),
    `║  Nível: ${riskAssessment?.risk_level || 'N/A'}  |  ${riskAssessment?.recommendation || 'N/A'}`,
    riskAssessment?.warnings?.length ? `║  ⚠️  ${riskAssessment.warnings[0]}` : '║  Sem alertas de risco',
    riskAssessment?.streak?.consecutive_losses >= 3 ? chalk.red(`║  📉 Streak: ${riskAssessment.streak.consecutive_losses} perdas seguidas — stake reduzida`) : '',
    chalk.blue('╠══════════════════════════════════════════════════════╣'),
    chalk.white(`║  ✅ ONDE APOSTAR — Superbet (superbet.bet.br)`),
    `║  Home Win : ${matchData.odds?.home_win || oddsAnalysis?.current_odds?.home_win || 'N/A'}`,
    `║  Empate   : ${matchData.odds?.draw     || oddsAnalysis?.current_odds?.draw     || 'N/A'}`,
    `║  Away Win : ${matchData.odds?.away_win || oddsAnalysis?.current_odds?.away_win || 'N/A'}`,
    chalk.bold.blue('╚══════════════════════════════════════════════════════╝'),
  ];

  const markdownLines = [
    `# ⚽ Análise: ${matchData.match}`,
    `**Data:** ${date} | **Competição:** ${matchData.competition}`,
    ``,
    `## 🎯 Recomendação Final`,
    `**${recommendation.label}** — Confiança: **${confidenceScore}/100**`,
    topBet ? `- **Mercado:** ${topBet.market} | **Odds:** ${topBet.odds} (${topBet.house}) | **EV:** ${topBet.ev_pct}` : '',
    riskAssessment?.stake ? `- **Stake:** R$ ${riskAssessment.stake} (${riskAssessment.stake_pct}% da banca)` : '',
    ``,
    `## 📊 Análise Quantitativa`,
    `| Resultado | Prob. Real | Odds Justa |`,
    `|-----------|-----------|-----------|`,
    `| Home Win  | ${pctStr(quantAnalysis.probabilities?.home_win)} | ${quantAnalysis.fair_odds?.home_win} |`,
    `| Empate    | ${pctStr(quantAnalysis.probabilities?.draw)} | ${quantAnalysis.fair_odds?.draw} |`,
    `| Away Win  | ${pctStr(quantAnalysis.probabilities?.away_win)} | ${quantAnalysis.fair_odds?.away_win} |`,
    `| Over 2.5  | ${pctStr(quantAnalysis.probabilities?.over_2_5)} | ${quantAnalysis.fair_odds?.over_2_5} |`,
    ``,
    `## ♟️ Análise Tática`,
    `- **Edge:** ${tacticalAnalysis.tactical_edge}`,
    ...(tacticalAnalysis.key_factors || []).map((f) => `- ${f}`),
    tacticalAnalysis.risk_flags?.length ? `\n**Alertas:** ${tacticalAnalysis.risk_flags.join('; ')}` : '',
    ``,
    `## 📰 Notícias`,
    `- **${newsAnalysis?.home?.team}:** ${newsAnalysis?.home?.summary}`,
    `- **${newsAnalysis?.away?.team}:** ${newsAnalysis?.away?.summary}`,
    ``,
    ...buildArielMarkdownLines(scorePrediction),
    ``,
    `## 🛡️ Gestão de Risco`,
    `- **Risco:** ${riskAssessment?.risk_level} | **Stake:** R$ ${riskAssessment?.stake}`,
    ...(riskAssessment?.warnings || []).map((w) => `- ⚠️ ${w}`),
    riskAssessment?.streak?.consecutive_losses >= 3 ? `- 📉 **Streak:** ${riskAssessment.streak.consecutive_losses} perdas seguidas (${riskAssessment.streak.recent_results})` : '',
    ``,
    `---`,
    `*Gerado em ${new Date().toLocaleString('pt-BR')} pelo Betting Analysis Squad*`,
  ];

  return {
    terminal: terminalLines.filter(Boolean).join('\n'),
    markdown: markdownLines.filter((l) => l !== '').join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seção Ariel (ScorePredictor) no terminal
// ─────────────────────────────────────────────────────────────────────────────
function buildArielTerminalLines(sp) {
  if (!sp) return [];
  const lines = [chalk.magenta(`║  🎯 ARIEL — PLACAR EXATO & DUPLA CHANCE`)];

  // Top-3 placares mais prováveis
  const topScores = (sp.exact_scores || []).slice(0, 3);
  if (topScores.length) {
    const scoreLine = topScores
      .map((s) => `${s.score}(${(s.prob * 100).toFixed(1)}%)`)
      .join(' | ');
    lines.push(`║  Placares: ${scoreLine}`);
  }

  // Vitória com margem
  const vd = sp.victory_depth;
  if (vd?.favorite) {
    const margin1 = (vd.margin_1 * 100).toFixed(0);
    const margin2 = (vd.margin_2 * 100).toFixed(0);
    lines.push(`║  Vitória ${vd.favorite}: 1 gol ${margin1}% | 2+ gols ${margin2}%`);
  }

  // Double Chance com valor real
  const dcBets = (sp.double_chance_bets || []).filter((b) => b.has_value);
  if (dcBets.length) {
    const best = dcBets[0];
    lines.push(`║  Dupla Chance: ${best.market} ${(best.probability * 100).toFixed(1)}% | EV ${best.ev_pct} ⭐`);
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seção Ariel no Markdown
// ─────────────────────────────────────────────────────────────────────────────
function buildArielMarkdownLines(sp) {
  if (!sp) return [];
  const lines = [`## 🎯 Ariel — Placar Exato & Dupla Chance`];

  const topScores = (sp.exact_scores || []).slice(0, 5);
  if (topScores.length) {
    lines.push(`| Placar | Probabilidade | EV | Odds Mínima |`);
    lines.push(`|--------|-------------|-----|------------|`);
    for (const s of topScores) {
      const ev = s.ev != null ? `${(s.ev * 100).toFixed(1)}%` : '-';
      lines.push(`| **${s.score}** | ${(s.prob * 100).toFixed(1)}% | ${ev} | ${s.min_odds ?? '-'} |`);
    }
  }

  const dcBets = (sp.double_chance_bets || []);
  if (dcBets.length) {
    lines.push(``);
    lines.push(`**Dupla Chance:**`);
    for (const b of dcBets) {
      const star = b.has_value ? ' ⭐ value' : '';
      lines.push(`- ${b.market}: ${(b.probability * 100).toFixed(1)}% | EV ${b.ev_pct}${star}`);
    }
  }

  return lines;
}

function buildScoreLine(scores) {
  if (!scores) return '';
  const h = scores.home?.score?.toFixed(2);
  const a = scores.away?.score?.toFixed(2);
  const fav = scores.favoritismo;
  return `║  Score v5.4: ${h} vs ${a}  |  ${fav?.toUpperCase()}`;
}

function buildProgressBar(score) {
  const filled = Math.round(score / 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function pctStr(prob) {
  return prob ? `${(prob * 100).toFixed(1)}%` : 'N/A';
}

function saveReport(matchName, content) {
  try {
    const dir = './reports';
    mkdirSync(dir, { recursive: true });
    const filename = `${matchName.replace(/\s/g, '_')}_${Date.now()}.md`;
    writeFileSync(join(dir, filename), content, 'utf-8');
    console.log(`📁 Relatório salvo: reports/${filename}`);
  } catch {
    // silencioso
  }
}
