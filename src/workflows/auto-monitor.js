/**
 * Auto Monitor v6 — Análise automática completa + PIE + Treino automático
 *
 * Fluxo por ciclo horário:
 *  1. Busca resultados de partidas finalizadas → treina agentes automaticamente (PIE)
 *  2. Escaneia próximas 24h → analisa todos os jogos
 *  3. Envia apenas análises com Prob ≥ 80% E Confiança ≥ 75%
 *  4. Jogos sem edge: descartados silenciosamente
 *  5. Bot: /resultado N placar · /grade · /stats · /licoes
 */

import chalk from 'chalk';
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { closeBrowser } from '../scrapers/flashscore.js';
import { closeAcademiaBrowser } from '../scrapers/academia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIFIED_KEYS_FILE = join(__dirname, '../../data/notified-keys.json');
import { aggregateUpcomingMatches, aggregateMatchData } from '../scrapers/aggregator.js';
import {
  notifyGradeDoDia,
  notifyMiniGrade,
  notifyMarketAnalysis,
  notifyMatchResult,
  notifyResultReminder,
  notifyPIEStats,
  notifyLicoes,
  notifyError,
  sendStartup,
  deleteGroupMessages,
  deleteMatchMessages,
} from '../utils/telegram.js';
import { TelegramBot } from '../utils/telegram-bot.js';
import { saveAnalysis } from '../utils/storage.js';
import { savePrediction, saveAgentLog, getPredictionByIdx, getStats, getAllActiveLessons, purgeOrphanedPredictions } from '../pie/pie-storage.js';
import { analyzeResult } from '../pie/pie-analyzer.js';
import { buildTags, calcEV } from '../pie/pie-context.js';
import { logExpertiseSummary } from '../pie/pie-trainer.js';
import { autoFetchResults } from '../utils/result-fetcher.js';
import { buildPerformanceDashboard, buildAgentMiniUpdate } from '../pie/pie-dashboard.js';
import { notifyPerformanceDashboard, notifyAgentMiniUpdate, notifyLive2TOpportunity } from '../utils/telegram.js';
import { startLiveScan } from './live-scan.js';
import { runLive2TFunnel } from '../funnels/funnel-live-2t.js';
import {
  saveMatchResult,
  saveAnalisePreLive,
  rebuildDashboard,
  updateAgendaHoje,
  updateSessaoAtual,
  updatePadroesAprendidos,
  updateRoiPerformance,
} from '../utils/obsidian.js';
import { status as memStatus, wakeUp as memWakeUp, kgAdd, diaryWrite } from '../utils/mempalace.js';
import { loadAnalysisHistory, persistAnalysisHistory } from '../utils/history-store.js';

import { BTTSAgent }         from '../../squads/betting-analysis/market-agents/BTTSAgent.js';
import { GoalsAgent }        from '../../squads/betting-analysis/market-agents/GoalsAgent.js';
import { CornersAgent }      from '../../squads/betting-analysis/market-agents/CornersAgent.js';
import { YellowCardsAgent }  from '../../squads/betting-analysis/market-agents/YellowCardsAgent.js';
import { DoubleChanceAgent } from '../../squads/betting-analysis/market-agents/DoubleChanceAgent.js';
import { ExactScoreAgent }   from '../../squads/betting-analysis/market-agents/ExactScoreAgent.js';

const SCAN_INTERVAL_MINUTES  = parseInt(process.env.SCAN_INTERVAL_MINUTES  || '60');
const LIVE_INTERVAL_MINUTES  = parseInt(process.env.LIVE_SCAN_INTERVAL_MINUTES || '15');
const REEVAL_INTERVAL_H      = parseInt(process.env.REEVAL_INTERVAL_H      || '12');
const MIN_PROBABILITY        = parseInt(process.env.MIN_CONFIDENCE_SCORE   || '83');
const MIN_CONFIDENCE         = 78; // confiança mínima fixa
const MIN_COMBINED           = 65; // score combinado mínimo: prob × conf / 100
const MAX_MATCHES_PER_SCAN   = parseInt(process.env.MAX_MATCHES_PER_SCAN   || '20');
const MATCH_DELAY_MS         = 8000; // pausa entre análises de jogos (reduz pressão na API)

const BASE_TG = 'https://api.telegram.org';

let currentGrade   = [];
const notifiedKeys    = _loadNotifiedKeys(); // persiste entre reinicializações
const analysisHistory = loadAnalysisHistory(); // persiste em disco entre reinicializações
const resultReminders = new Set(); // idx — já enviou lembrete de resultado
let lastScanFoundNothing = false; // suprime mensagem repetida de "0 oportunidades"
let lastScanTime = 0;             // timestamp do último scan enviado ao Telegram

// Map compartilhado entre live-scan e funnel-live-2t — chave única live_*
// garante que nenhuma oportunidade seja enviada duas vezes por funnels diferentes
const liveNotifiedKeys = new Map();

function _loadNotifiedKeys() {
  try {
    if (existsSync(NOTIFIED_KEYS_FILE)) {
      const data = JSON.parse(readFileSync(NOTIFIED_KEYS_FILE, 'utf-8'));
      // Limpa chaves com mais de 2 dias para não crescer indefinidamente
      const cutoff = Date.now() - 2 * 86_400_000;
      const fresh = Object.entries(data).filter(([, ts]) => ts > cutoff);
      return new Map(fresh); // Map de key → timestamp
    }
  } catch { /* ignora */ }
  return new Map();
}

function _saveNotifiedKeys() {
  try {
    const obj = Object.fromEntries(notifiedKeys);
    writeFileSync(NOTIFIED_KEYS_FILE, JSON.stringify(obj), 'utf-8');
  } catch { /* ignora */ }
}

const MARKET_AGENTS = [
  new BTTSAgent(),
  new GoalsAgent(),
  new CornersAgent(),
  new YellowCardsAgent(),
  new DoubleChanceAgent(),
  new ExactScoreAgent(),
];

// ── Funil Live 2T — wrapper com notificações Telegram ─────────────────────────
async function runLive2TScan() {
  const ts = timestamp();
  console.log(chalk.bold.yellow(`\n[${ts}] 🟡 Funil LIVE 2T — scan iniciado`));

  try {
    const opportunities = await runLive2TFunnel(liveNotifiedKeys);

    if (!opportunities.length) {
      console.log(chalk.gray(`  [LIVE-2T] Scan concluído — sem oportunidades`));
      return;
    }

    // Agrupa por jogo para enviar UMA notificação por jogo
    // Normaliza a chave para evitar duplicatas por espaço/capitalização
    const _normalizeMatchKey = (s) => (s || 'unknown').toLowerCase().replace(/\s+/g, ' ').trim();
    const byMatch = new Map();
    for (const opp of opportunities) {
      const liveData = opp._liveData;
      const key      = _normalizeMatchKey(liveData?.match);
      if (!byMatch.has(key)) byMatch.set(key, { liveData, markets: [] });
      // Remove _liveData do objeto de mercado antes de enviar
      const { _liveData, ...market } = opp;
      byMatch.get(key).markets.push(market);
    }

    for (const { liveData, markets } of byMatch.values()) {
      await notifyLive2TOpportunity(liveData, markets).catch(() => {});
      _saveNotifiedKeys();
    }

    console.log(chalk.bold.yellow(`  [LIVE-2T] ✅ ${opportunities.length} oportunidade(s) enviadas`));
  } catch (err) {
    console.error(chalk.red(`[LIVE-2T] Erro no scan: ${err.message}`));
  }
}

// ── Aprendizado por comparação — alimenta MemPalace e diário dos agentes ──────
async function _learnFromComparison(matchData, placar, analyses) {
  try {
    const parts = placar.split(/[-x×:]/i).map((s) => parseInt(s.trim(), 10));
    const hg    = isNaN(parts[0]) ? 0 : parts[0];
    const ag    = isNaN(parts[1]) ? 0 : parts[1];
    const total = hg + ag;
    const btts  = hg > 0 && ag > 0;

    const AGENT_MAP = {
      BTTS: 'BTTSAgent', Gols: 'GoalsAgent', Escanteios: 'CornersAgent',
      Cartões: 'YellowCardsAgent', DuplaChance: 'DoubleChanceAgent', PlacarExato: 'ExactScoreAgent',
    };

    for (const a of analyses) {
      const market = a.market     || a.mercado        || '';
      const rec    = a.recommendation || a.recomendacao || '';
      const prob   = a.probabilidade  || 0;
      const conf   = a.confianca      || 0;
      const mu     = market.toUpperCase();
      const ru     = rec.toUpperCase();

      let acertou = null;

      if (mu.includes('BTTS') || mu.includes('AMBAS')) {
        acertou = (ru === 'SIM' || ru === 'APOSTAR') ? btts : !btts;
      } else if (mu.includes('GOLS') || mu.includes('TOTAL') || mu.includes('OVER') || mu.includes('UNDER')) {
        const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '2.5');
        if (ru.includes('OVER') || ru === 'SIM' || ru === 'APOSTAR')  acertou = total > linha;
        else if (ru.includes('UNDER') || ru === 'NÃO')                acertou = total < linha;
      } else if (mu.includes('DUPLA') || mu.includes('CHANCE')) {
        if (ru === '1X')      acertou = hg >= ag;
        else if (ru === 'X2') acertou = ag >= hg;
        else if (ru === '12') acertou = hg !== ag;
      }

      if (acertou === null) continue;

      const outcome  = acertou ? 'GREEN' : 'RED';
      const matchKey = (matchData.match || '').replace(/\s+/g, '_').toLowerCase();

      // Knowledge Graph — fato desta predição vs resultado real
      await kgAdd(matchKey, `pred_${market}_${prob}pct`, outcome, { confidence: 1.0 }).catch(() => {});
      await kgAdd(market,   `accuracy_${prob}pct_conf${conf}`, outcome, { confidence: 0.9 }).catch(() => {});
      if (matchData.competition) {
        await kgAdd(matchData.competition.replace(/\s+/g, '_'), `${market}_${outcome}`, `${prob}pct`, { confidence: 0.85 }).catch(() => {});
      }

      // Diário do agente — entrada de aprendizado com contexto completo
      const agentKey  = Object.keys(AGENT_MAP).find((k) => mu.includes(k.toUpperCase())) || market;
      const agentName = AGENT_MAP[agentKey] || `${agentKey}Agent`;
      const emoji     = acertou ? '✅ GREEN' : '❌ RED';
      const entry     = `[RESULTADO] ${matchData.match} [${matchData.competition || '?'}] ` +
                        `${market} → ${rec} (Prob: ${prob}% / Conf: ${conf}%) → ${emoji} ` +
                        `| Placar: ${placar} | Gols: ${total} | BTTS: ${btts ? 'SIM' : 'NÃO'}`;
      await diaryWrite(agentName, entry).catch(() => {});

      console.log(chalk.gray(`    🧠 [Learn] ${agentName}: ${market} ${rec} ${prob}% → ${outcome}`));
    }
  } catch (err) {
    console.warn(chalk.gray(`[Learn] Erro ao aprender da comparação: ${err.message}`));
  }
}

// ── Seed de padrões validados manualmente no MemPalace ───────────────────────
/**
 * Registra padrões confirmados pelo usuário no Knowledge Graph.
 * Executado uma vez ao iniciar — o KG é idempotente (não duplica fatos existentes).
 */
async function _seedValidatedPatterns() {
  const facts = [
    // Padrão "Perdedor Dominante" — Over 1.5 Live
    // Validado: Famalicão 0-1 Moreirense, 74', Liga Portugal, 10/04/2026 ✅
    ['padrao_live_over15', 'condicao', 'gols_totais=1 AND xG_perdedor>xG_vencedor AND posse_perdedor>=54% AND minutos_restantes>=10'],
    ['padrao_live_over15', 'probabilidade_base', '82%'],
    ['padrao_live_over15', 'ajuste_mandante_perdendo', '+3%'],
    ['padrao_live_over15', 'ajuste_pressao_alta', '+5% se pressao>0.7'],
    ['padrao_live_over15', 'validado_em', 'Famalicao_vs_Moreirense_74min_0-1_Liga_Portugal_2026'],
    ['padrao_live_over15', 'mercado', 'Over_1.5_Gols'],
    ['padrao_live_over15', 'resultado', 'GREEN_100pct_aproveitamento'],
    // Fatos sobre o jogo específico validado
    ['Famalicao_vs_Moreirense', 'padrao_live', 'perdedor_dominante'],
    ['Famalicao_vs_Moreirense', 'over15_gols', 'GREEN_74min_placar0-1'],
    ['Liga_Portugal_Betclic',   'padrao_over15_live', 'perdedor_dominante_confirmado'],
  ];

  for (const [s, p, o] of facts) {
    await kgAdd(s, p, o, { confidence: 1.0 }).catch(() => {});
  }

  // Diário dos agentes live
  const entry = 'Padrão PERDEDOR DOMINANTE validado: Famalicão 0-1 Moreirense 74\' — Over 1.5 ✅. Condições: xG_perdedor>xG_vencedor + posse>=54% + 1 gol + >=10min → prob>=82%.';
  await diaryWrite('LiveInPlayAgent', entry).catch(() => {});
  await diaryWrite('Live2TAgent', entry).catch(() => {});
}

// ── Entrada principal ─────────────────────────────────────────────────────────
export async function startAutoMonitor() {
  _validateEnv();

  console.log(chalk.bold.green(`
╔══════════════════════════════════════════════════════╗
║  🤖 BET ANALYSIS SQUAD — MODO AUTOMÁTICO v5          ║
║  Análise completa · 24h · Sem intervenção manual     ║
║  Mercados: BTTS · Gols · Escanteios · Cartões        ║
║            Dupla Chance · Placar Exato                ║
║  Gate: Prob ≥ ${MIN_PROBABILITY}% · Confiança ≥ ${MIN_CONFIDENCE}%                ║
╚══════════════════════════════════════════════════════╝
  `));

  logExpertiseSummary(); // exibe calibração dos agentes no console ao iniciar

  // Verificar MemPalace
  const mem = await memStatus().catch(() => null);
  if (mem?.available) {
    console.log(chalk.magenta(`🧠 MemPalace: ${mem.drawers} drawers indexados — busca semântica ATIVA`));
    const wakeCtx = await memWakeUp().catch(() => '');
    if (wakeCtx) console.log(chalk.gray(`   Wake-up: ${wakeCtx.slice(0, 120)}...`));

    // Registrar padrões validados manualmente (one-time seed de conhecimento)
    _seedValidatedPatterns().catch(() => {});
  } else {
    console.log(chalk.gray(`🧠 MemPalace: indisponível — análises sem memória semântica`));
  }

  // Inicializar Obsidian — Dashboard + Sessão Atual na inicialização
  try {
    rebuildDashboard();
    updateSessaoAtual({ fase: 'Iniciando...', scanned: 0, opportunities: 0 });
    console.log(chalk.green(`📓 Obsidian: Dashboard e Sessão Atual atualizados`));
  } catch (e) { /* vault não configurado — ignora silenciosamente */ }

  console.log(chalk.gray('🗑️  Limpando mensagens do grupo...'));
  // Protege mensagens de análises ativas (sem resultado) de sessões anteriores
  const protectedIds = new Set(
    [...analysisHistory.values()]
      .filter((e) => !e.resultRegistered)
      .flatMap((e) => e.messageIds || [])
  );
  await deleteGroupMessages(protectedIds).catch(() => {});
  await sendStartup(SCAN_INTERVAL_MINUTES, 24).catch(() => {});

  await fetchAndAnalyze();

  setInterval(async () => {
    await fetchAndAnalyze().catch((err) => {
      console.error(chalk.red(`[Monitor] Erro: ${err.message}`));
      notifyError('Auto Monitor', err).catch(() => {});
    });
  }, SCAN_INTERVAL_MINUTES * 60_000);

  // Verificar a cada 5 minutos se algum jogo terminou (2h após kickoff)
  setInterval(() => checkMatchReminders().catch(() => {}), 5 * 60_000);

  // Re-avaliação completa a cada 12h — reanálisa jogos futuros com dados atualizados
  setInterval(() => reevalMarkets().catch(() => {}), REEVAL_INTERVAL_H * 3_600_000);

  // ── FUNIL LIVE GERAL: scan in-play a cada 15 min ─────────────────────────────
  // Usa liveNotifiedKeys compartilhado para evitar duplicatas com o funil 2T
  setTimeout(() => {
    startLiveScan({ loop: false, sharedNotifiedKeys: liveNotifiedKeys }).catch(() => {});
    setInterval(() => {
      startLiveScan({ loop: false, sharedNotifiedKeys: liveNotifiedKeys }).catch((err) => {
        console.error(chalk.red(`[Live Scan] Erro no loop: ${err.message}`));
      });
    }, LIVE_INTERVAL_MINUTES * 60_000);
  }, 5 * 60_000);

  // ── FUNIL LIVE 2T: scan exclusivo do 2° Tempo a cada 10 min ──────────────────
  // Usa o mesmo liveNotifiedKeys — bloqueia duplicatas entre os dois funnels
  const LIVE2T_INTERVAL_MINUTES = parseInt(process.env.LIVE2T_SCAN_INTERVAL_MINUTES || '10');
  setTimeout(() => {
    runLive2TScan().catch(() => {});
    setInterval(() => {
      runLive2TScan().catch((err) => {
        console.error(chalk.red(`[Live 2T] Erro no loop: ${err.message}`));
      });
    }, LIVE2T_INTERVAL_MINUTES * 60_000);
  }, 8 * 60_000);

  // Bot com todos os comandos, incluindo /live2t
  const bot = new TelegramBot({
    token:                process.env.TELEGRAM_BOT_TOKEN,
    groupId:              process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID,
    onGradeRequest:       () => notifyGradeDoDia(currentGrade).catch(() => {}),
    onResultRequest:      handleResultCommand,
    onStatsRequest:       handleStatsCommand,
    onLicoesRequest:      handleLicoesCommand,
    onPerformanceRequest: handlePerformanceCommand,
    onScanRequest:        handleScanCommand,
    onLiveScanRequest:    handleLiveScanCommand,
    onLive2TRequest:      handleLive2TCommand,
  });
  await bot.start();

  console.log(chalk.gray(`\n✅ Bot ativo. Comandos: /resultado N placar · /grade · /stats · /licoes\n`));
  await new Promise(() => {});
}

// ── Buscar grade + analisar todos os jogos ────────────────────────────────────
async function fetchAndAnalyze() {
  console.log(chalk.bold.cyan(`\n[${timestamp()}] 🔄 Iniciando ciclo horário...`));

  // FASE 0 — Buscar resultados de partidas finalizadas e treinar agentes
  purgeOrphanedPredictions(7); // limpa predições sem resultado com > 7 dias
  await autoFetchResults(analysisHistory, handleAutoResult).catch((err) => {
    console.error(chalk.red(`[Result Fetcher] Erro: ${err.message}`));
  });

  console.log(chalk.bold.cyan(`[${timestamp()}] 📅 Escaneando próximas 24h...`));

  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const now             = Date.now();
    const horasDecorridas = (now - startOfDay.getTime()) / 3_600_000;
    const horasBusca      = Math.min(24 + horasDecorridas, 48);

    const date = startOfDay.toISOString().split('T')[0];
    const all  = await aggregateUpcomingMatches(date, horasBusca);

    const limite    = new Date(now + 24 * 3_600_000);
    const filtrados = all.filter((m) => {
      if (!m.date) return true;
      const t = new Date(m.date).getTime();
      return t >= now - 3_600_000 && t <= limite.getTime();
    });

    currentGrade = filtrados.slice(0, MAX_MATCHES_PER_SCAN);
    console.log(chalk.white(`  ${currentGrade.length} jogos encontrados — analisando...`));
  } finally {
    await closeBrowser().catch(() => {});
    await closeAcademiaBrowser().catch(() => {});
  }

  // Atualizar Sessão Atual — fase de análise
  try { updateSessaoAtual({ fase: 'Analisando jogos...', scanned: currentGrade.length, opportunities: 0 }); } catch {}

  // 1. Computar análises de todos os jogos (sem enviar ainda)
  const allApproved = [];
  for (let i = 0; i < currentGrade.length; i++) {
    const result = await analyzeMatch(currentGrade[i], i + 1);
    if (result) allApproved.push(result);
    if (i < currentGrade.length - 1) await sleep(MATCH_DELAY_MS);
  }

  console.log(chalk.bold.green(`\n  ✅ Ciclo concluído — ${allApproved.length}/${currentGrade.length} jogos com oportunidades`));

  // Atualizar Obsidian — Agenda Hoje + Sessão Atual ao fim de cada ciclo
  try {
    const approvedForAgenda = allApproved.map((r) => r.matchData);
    updateAgendaHoje(currentGrade, approvedForAgenda);
    updateSessaoAtual({
      fase:          allApproved.length ? 'Oportunidades encontradas' : 'Monitorando...',
      scanned:       currentGrade.length,
      opportunities: allApproved.length,
      lastMatch:     currentGrade[currentGrade.length - 1]?.match || null,
    });
    rebuildDashboard();
  } catch {}

  if (!allApproved.length) {
    // Envia mensagem de "0 oportunidades" apenas na 1ª vez consecutiva (evita spam)
    if (!lastScanFoundNothing) {
      lastScanFoundNothing = true;
      await sendText(
        `🔍 <b>Scan concluído — ${timestamp()}</b>\n\n` +
        `Analisados: <b>${currentGrade.length}</b> jogos\n` +
        `Nenhuma oportunidade atingiu os critérios:\n` +
        `• Probabilidade ≥ ${MIN_PROBABILITY}%\n` +
        `• Confiança ≥ ${MIN_CONFIDENCE}%`
      );
    } else {
      console.log(chalk.gray(`  ⏭  Sem oportunidades (mensagem suprimida — scan anterior também vazio)`));
    }
    return;
  }

  lastScanFoundNothing = false; // encontrou oportunidades — resetar flag

  // Re-indexar novos arquivos no MemPalace em background (não bloqueia o ciclo)
  _reindexMemPalace();

  // 2. Mini-grade: apenas jogos com oportunidade
  await notifyMiniGrade(allApproved).catch(() => {});
  await sleep(2000);

  // 3. Análise detalhada + persistência de cada jogo aprovado
  for (const r of allApproved) {
    // Guarda o message_id para apagar a mensagem após o resultado
    const msgId = await notifyMarketAnalysis(r.matchData, r.enriched).catch(() => null);

    // Salva análise pré-live no Obsidian (nota individual com todos os mercados aprovados)
    try { saveAnalisePreLive(r.matchData, r.enriched); } catch {}

    for (const e of r.enriched) {
      notifiedKeys.set(`${r.matchId}_${e.market}`, Date.now());
      await saveAnalysis({
        match_id: r.matchId, match_name: r.matchData.match,
        competition: r.matchData.competition, match_date: r.matchData.date,
        confidence_score: e.probabilidade, recommendation: e.recommendation,
        market: e.market,
      }).catch(() => {});
    }
    _saveNotifiedKeys();

    const sfId   = r.matchData.sofascore_id || r.matchData.match_id || null;
    const predId = savePrediction({
      idx: r.idx, matchData: r.matchData, markets: r.sentResults,
      sofascoreId: sfId, kickoffTime: r.kickoffTime,
    });
    analysisHistory.set(r.idx, {
      matchData:        r.matchData,
      approved:         r.sentResults,
      predictionId:     predId,
      kickoffTime:      r.kickoffTime,
      resultRegistered: false,
      sofascoreId:      sfId,
      messageIds:       msgId ? [msgId] : [],
    });
    persistAnalysisHistory(analysisHistory); // persiste em disco imediatamente
    console.log(chalk.green(`    ✅ ${r.sentResults.length} mercado(s) — PIE ${predId.slice(0,8)}`));
  }
}

// ── Computar análise de um jogo — retorna dados ou null (não envia) ──────────
async function analyzeMatch(match, idx) {
  const label = `${match.home_team || match.match} vs ${match.away_team || ''}`.trim();

  const matchTs  = match.date ? new Date(match.date).getTime() : parseMatchTime(match.match_time);
  const horasAte = (matchTs - Date.now()) / 3_600_000;
  if (horasAte < -2) return null; // jogo encerrado

  // Dedup de jogo inteiro: se todos os mercados deste jogo foram notificados
  // nas últimas 55 min, pula sem chamar a IA (economiza tokens e RPM)
  const matchKey = `${match.home_team || match.match}_${match.away_team || ''}`;
  const cutoff55 = Date.now() - 55 * 60_000;
  const todosNotificados = ['BTTS', 'Gols', 'Escanteios', 'Cartões', 'DuplaChance', 'PlacarExato']
    .every((m) => {
      const ts = notifiedKeys.get(`${matchKey}_${m}`) ?? notifiedKeys.get(`${label}_${m}`);
      return ts && ts > cutoff55;
    });
  if (todosNotificados) {
    console.log(chalk.gray(`\n  ⚽ [${idx}/${currentGrade.length}] ${label}  ⏭  já analisado (<55min)`));
    return null;
  }

  console.log(chalk.white(`\n  ⚽ [${idx}/${currentGrade.length}] ${label}`));

  let matchData;
  try {
    matchData = await aggregateMatchData(match);
  } catch (err) {
    console.log(chalk.red(`    ❌ Falha: ${err.message}`));
    return null;
  }

  const temDados = matchData.home?.form || matchData.h2h?.length || matchData.home?.goals_scored_avg;
  if (!temDados) {
    console.log(chalk.gray(`    ⏭  Dados insuficientes`));
    return null;
  }

  const results = await runMarketAgents(matchData);
  if (!results.length) return null;

  const approved = results.filter((r) => {
    const prob     = r.probabilidade ?? r.probability   ?? 0;
    const conf     = r.confianca     ?? r.confidence    ?? 0;
    const rec      = r.recomendacao  ?? r.recommendation ?? '';
    const combined = (prob * conf) / 100;
    return prob >= MIN_PROBABILITY
      && conf >= MIN_CONFIDENCE
      && combined >= MIN_COMBINED
      && rec !== 'INCERTO' && rec !== 'NÃO';
  });

  console.log(chalk.white(`    Agentes: ${results.length} | Aprovados: ${approved.length}`));
  if (!approved.length) return null;

  const matchId = matchData.match_id || matchData.match || label;
  const novos   = approved.filter((r) => !notifiedKeys.has(`${matchId}_${r.mercado ?? r.market}`));
  if (!novos.length) return null; // já notificado (persiste entre reinicializações)

  const enriched = novos.map((r) => ({
    ...r,
    market:         r.mercado  ?? r.market,
    recommendation: r.recomendacao ?? r.recommendation,
    probabilidade:  r.probabilidade ?? r.probability,
    confianca:      r.confianca ?? r.confidence ?? 0,
    odds_minima:    r.odds_minima_recomendada ?? null,
    ev:             calcEV(r.probabilidade ?? r.probability, r.odds_minima_recomendada),
    tags:           buildTags(matchData, r.mercado ?? r.market ?? ''),
  }));

  const sentResults = enriched.map((r) => ({
    market: r.market, recommendation: r.recommendation,
    probabilidade: r.probabilidade, confianca: r.confianca,
    odds_minima: r.odds_minima, ev: r.ev,
  }));

  return { idx, matchData, enriched, sentResults, matchId, kickoffTime: matchTs };
}

// ── Resultado automático (via Result Fetcher — sem intervenção humana) ───────
async function handleAutoResult({ idx, matchData, placar, approved, predictionId }) {
  const label = matchData.match || `Jogo #${idx}`;
  console.log(chalk.bold.green(`\n  🎓 [Auto-Treino] ${label} — ${placar}`));

  const piePred = predictionId
    ? { id: predictionId, markets: approved, match_name: label, competition: matchData.competition }
    : getPredictionByIdx(idx);

  let pieResult = null;
  if (piePred) {
    pieResult = analyzeResult(piePred, placar);
    const n = pieResult.newLessons.length;
    console.log(chalk.gray(`      🧠 PIE: ${n} lição(ões) gerada(s) automaticamente`));
    if (n) logExpertiseSummary();
  }

  // Apaga mensagem de análise original — resultado já foi enviado
  const entry = analysisHistory.get(idx);
  if (entry?.messageIds?.length) {
    await deleteMatchMessages(entry.messageIds).catch(() => {});
  }

  // Notifica resultado + comparativo Green/Red
  await notifyMatchResult(matchData, idx, placar, approved, '🤖 Auto', pieResult).catch(() => {});

  // Salva resultado completo no Obsidian
  saveMatchResult(matchData, placar, approved, pieResult);

  // Aprendizado por comparação — alimenta MemPalace + diário dos agentes
  await _learnFromComparison(matchData, placar, approved);

  // Atualiza padrões e ROI no Obsidian após cada resultado
  try {
    updatePadroesAprendidos(getAllActiveLessons());
    updateRoiPerformance(getStats());
    rebuildDashboard();
  } catch {}

  // Mini-update de performance — apenas quando PIE tem outcomes verificáveis
  const temVerificaveis = pieResult?.marketOutcomes?.some((o) => o.acertou !== null);
  if (temVerificaveis) {
    const mercadosAfetados = new Set(
      pieResult.marketOutcomes
        .filter((o) => o.acertou !== null)
        .map((o) => o.market)
        .filter(Boolean)
    );
    for (const market of mercadosAfetados) {
      const miniReport = buildAgentMiniUpdate(market);
      if (miniReport?.total >= 1) {
        await notifyAgentMiniUpdate(miniReport, label).catch(() => {});
      }
    }
  }
}

// ── Handlers do bot (resultados manuais/stats/licoes/grade) ──────────────────
async function handleResultCommand(idx, placar, requester) {
  const entry = analysisHistory.get(idx);
  if (!entry) {
    await sendText(
      `❌ Nenhuma análise registrada para o jogo #${idx}.\n` +
      `Só é possível comparar jogos que foram analisados neste ciclo.`
    );
    return;
  }
  entry.resultRegistered = true;
  persistAnalysisHistory(analysisHistory); // persiste estado atualizado
  const { matchData, approved, predictionId, messageIds } = entry;
  const label = matchData.match || `Jogo #${idx}`;
  console.log(chalk.white(`\n  📊 Resultado de ${label}: ${placar} (por ${requester})`));

  // Apaga mensagem de análise original antes de enviar o resultado
  if (messageIds?.length) {
    await deleteMatchMessages(messageIds).catch(() => {});
  }

  const piePred = predictionId
    ? { id: predictionId, markets: approved, match_name: label, competition: matchData.competition }
    : getPredictionByIdx(idx);

  let pieResult = null;
  if (piePred) {
    pieResult = analyzeResult(piePred, placar);
    console.log(chalk.gray(`  🧠 PIE: ${pieResult.newLessons.length} lição(ões)`));
  }
  await notifyMatchResult(matchData, idx, placar, approved, requester, pieResult).catch(() => {});

  // Salva resultado completo no Obsidian
  saveMatchResult(matchData, placar, approved, pieResult);

  // Aprendizado por comparação — alimenta MemPalace + diário dos agentes
  await _learnFromComparison(matchData, placar, approved);

  // Atualiza padrões e ROI no Obsidian após resultado manual
  try {
    updatePadroesAprendidos(getAllActiveLessons());
    updateRoiPerformance(getStats());
    rebuildDashboard();
  } catch {}
}

async function handleStatsCommand(requester) {
  const stats = getStats();
  console.log(chalk.gray(`  📊 Stats solicitado por ${requester}`));
  await notifyPIEStats(stats).catch(() => {});
}

async function handleLicoesCommand(requester) {
  const licoes = getAllActiveLessons();
  console.log(chalk.gray(`  📚 Lições solicitado por ${requester}`));
  await notifyLicoes(licoes).catch(() => {});
}

async function handlePerformanceCommand(requester) {
  console.log(chalk.gray(`  🏆 Performance solicitado por ${requester}`));
  const dash = buildPerformanceDashboard();
  await notifyPerformanceDashboard(dash).catch(() => {});
}

async function handleScanCommand(requester) {
  console.log(chalk.bold.cyan(`\n[${timestamp()}] 🔄 Scan manual solicitado por ${requester}`));
  await sendText(
    `🔄 <b>Scan manual iniciado</b>\n` +
    `<i>Solicitado por ${requester} — analisando próximas 24h...</i>`
  );
  lastScanFoundNothing = false; // permite notificação mesmo se último scan foi vazio
  await fetchAndAnalyze().catch((err) => {
    console.error(chalk.red(`[Scan Manual] Erro: ${err.message}`));
    notifyError('Scan Manual', err).catch(() => {});
  });
}

async function handleLiveScanCommand(requester) {
  console.log(chalk.bold.red(`\n[${timestamp()}] 🔴 Live scan solicitado por ${requester}`));
  await sendText(
    `🔴 <b>Análise Live iniciada</b>\n` +
    `<i>Solicitado por ${requester} — buscando jogos em andamento...</i>`
  );
  await startLiveScan({ loop: false }).catch((err) => {
    console.error(chalk.red(`[Live Scan] Erro: ${err.message}`));
    notifyError('Live Scan', err).catch(() => {});
  });
}

async function handleLive2TCommand(requester) {
  console.log(chalk.bold.yellow(`\n[${timestamp()}] 🟡 Live 2T scan solicitado por ${requester}`));
  await sendText(
    `🟡 <b>Análise Live 2° Tempo iniciada</b>\n` +
    `<i>Solicitado por ${requester} — buscando jogos no 2° Tempo...</i>`
  );
  await runLive2TScan().catch((err) => {
    console.error(chalk.red(`[Live 2T] Erro: ${err.message}`));
    notifyError('Live 2T Scan', err).catch(() => {});
  });
}

// ── Re-avaliação periódica (12h) — reanálisa jogos futuros ───────────────────
async function reevalMarkets() {
  console.log(chalk.bold.yellow(`\n[${timestamp()}] 🔄 Re-avaliação de ${REEVAL_INTERVAL_H}h iniciada...`));

  const now = Date.now();
  let removidas = 0;

  // Remove chaves de jogos que ainda NÃO começaram — permite reanálise
  for (const [idx, entry] of analysisHistory.entries()) {
    if (!entry.kickoffTime || entry.kickoffTime <= now) continue; // já iniciou, manter
    if (entry.resultRegistered) continue;                         // resultado já registrado

    const matchId = entry.matchData.match_id || entry.matchData.match;
    for (const r of entry.approved) {
      const key = `${matchId}_${r.market}`;
      if (notifiedKeys.has(key)) { notifiedKeys.delete(key); removidas++; }
    }
    analysisHistory.delete(idx);
  }

  _saveNotifiedKeys();
  console.log(chalk.yellow(`  ${removidas} chave(s) liberada(s) para reavaliação`));

  // Notifica grupo apenas se há jogos para reanalisar (evita mensagem de re-avaliação vazia)
  if (removidas > 0) {
    await sendText(
      `🔄  <b>RE-AVALIAÇÃO AUTOMÁTICA</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⏱️  Ciclo de ${REEVAL_INTERVAL_H}h | ${removidas} jogo(s) sendo reanalisados\n` +
      `<i>Novas oportunidades enviadas em seguida, se detectadas.</i>`
    );
    lastScanFoundNothing = false; // permite notificação de "0 oportunidades" após re-eval
  }

  await fetchAndAnalyze().catch((err) => {
    console.error(chalk.red(`[Re-eval] Erro: ${err.message}`));
    notifyError('Re-avaliação', err).catch(() => {});
  });
}

// ── Verificar jogos finalizados — lembrete manual somente se auto-fetch falhou ─
async function checkMatchReminders() {
  const now = Date.now();
  for (const [idx, entry] of analysisHistory.entries()) {
    if (resultReminders.has(idx)) continue;    // lembrete já enviado
    if (entry.resultRegistered) continue;      // resultado já registrado (auto ou manual)
    if (!entry.kickoffTime) continue;

    // Lembrete manual apenas 3h após kickoff (dá tempo ao auto-fetch de tentar antes)
    const reminderAfter = entry.kickoffTime + 3 * 3_600_000;
    if (now >= reminderAfter) {
      resultReminders.add(idx);
      const label = entry.matchData.match || `Jogo #${idx}`;
      // Verifica se tem sofascoreId — se tiver, o auto-fetch deveria ter funcionado,
      // mas ainda assim envia lembrete como fallback
      const hasSofaId = !!(entry.sofascoreId);
      const note = hasSofaId
        ? `\n<i>🤖 Tentativa automática falhou — informe manualmente.</i>`
        : '';
      console.log(chalk.yellow(`\n  ⏱️ Jogo #${idx} — lembrete de resultado (auto-fetch ${hasSofaId ? 'falhou' : 'sem ID'})`));
      await notifyResultReminder(idx, label, entry.matchData.competition, note).catch(() => {});
    }
  }
}

// Flag global de quota esgotada — pausa todos os agentes quando ativo
let _quotaExhaustedUntil = 0;

// ── Rodar agentes em lotes de 2 ───────────────────────────────────────────────
async function runMarketAgents(matchData) {
  // Se quota esgotada e ainda dentro do período de pausa, pula análise
  if (Date.now() < _quotaExhaustedUntil) {
    const minRestantes = Math.ceil((_quotaExhaustedUntil - Date.now()) / 60_000);
    console.log(chalk.yellow(`    ⏸  Quota Gemini esgotada — retomando em ~${minRestantes}min`));
    return [];
  }

  const results   = [];
  const batchSize = 2;

  for (let i = 0; i < MARKET_AGENTS.length; i += batchSize) {
    const batch   = MARKET_AGENTS.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((agent) => agent.analyze(matchData))
    );
    for (const o of settled) {
      if (o.status === 'fulfilled') {
        const r    = o.value;
        const prob = r.probabilidade ?? r.probability ?? 0;
        const conf = r.confianca ?? r.confidence ?? 0;
        const pass = prob >= MIN_PROBABILITY && conf >= MIN_CONFIDENCE;
        console.log(chalk.gray(
          `    ${pass ? chalk.green('✅') : chalk.gray('⏭ ')} ` +
          `${(r.agent || '').padEnd(16)} prob:${prob}% conf:${conf}%`
        ));
        results.push(r);
      } else {
        const err = o.reason;
        if (err?.isQuotaError) {
          // Cota esgotada — circuit-breaker local (notificação Telegram já enviada pelo key-manager)
          if (Date.now() >= _quotaExhaustedUntil) {
            _quotaExhaustedUntil = Date.now() + 20 * 60_000;
            console.log(chalk.bold.yellow(`\n  ⚠️  Cota Gemini esgotada — análises pausadas por 20min`));
          }
          return []; // abandona análise deste jogo
        }
        console.log(chalk.red(`    ❌ ${err?.message?.slice(0, 60)}`));
      }
    }
    if (i + batchSize < MARKET_AGENTS.length) await sleep(6000);
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function sendText(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await axios.post(`${BASE_TG}/bot${token}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
  }).catch(() => {});
}

function parseMatchTime(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function timestamp() {
  return new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Re-indexar MemPalace em background após cada ciclo com oportunidades ──────
function _reindexMemPalace() {
  const PYTHON = process.env.MEMPALACE_PYTHON
    || 'C:\\Users\\PCHOME01\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
  execFile(PYTHON, ['-m', 'mempalace', 'mine', '.'], {
    cwd: join(__dirname, '../../'),
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeout: 60_000,
  }, (err) => {
    if (!err) console.log(chalk.gray('  🧠 MemPalace: re-indexação concluída'));
  });
}

// ── Validação de variáveis de ambiente essenciais ─────────────────────────────
function _validateEnv() {
  const warnings = [];
  if (!process.env.GEMINI_API_KEY)       warnings.push('GEMINI_API_KEY — agentes de mercado não funcionarão sem esta chave');
  if (!process.env.TELEGRAM_BOT_TOKEN)   warnings.push('TELEGRAM_BOT_TOKEN — notificações Telegram desativadas');
  if (!process.env.TELEGRAM_GROUP_ID && !process.env.TELEGRAM_CHAT_ID)
                                         warnings.push('TELEGRAM_GROUP_ID — notificações Telegram desativadas');

  if (warnings.length) {
    console.log(chalk.yellow('\n⚠️  Variáveis de ambiente ausentes:'));
    for (const w of warnings) console.log(chalk.yellow(`   • ${w}`));
    console.log(chalk.gray('   Configure o arquivo .env para habilitar todas as funcionalidades.\n'));
  } else {
    console.log(chalk.green('  ✅ Configuração de ambiente OK\n'));
  }
}
