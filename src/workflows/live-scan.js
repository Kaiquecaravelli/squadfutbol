/**
 * Live Scan — Análise de jogos em andamento (in-play)
 *
 * Fluxo:
 *  1. Busca todos os jogos ao vivo via SofaScore
 *  2. Para cada jogo: coleta stats em tempo real (xG, posse, chutes, ataques)
 *  3. Roda LiveInPlayAgent (Gemini) para identificar oportunidades
 *  4. Filtra: prob >= 80% E confiança >= 80% E recomendação APOSTAR
 *  5. Envia alertas individuais via Telegram
 *  6. Loop opcional: re-escaneia a cada N minutos
 *
 * Uso:
 *   node src/index.js live-scan                    → scan único agora
 *   node src/index.js live-scan --loop             → loop contínuo (10 min)
 *   node src/index.js live-scan --loop --interval=5 → loop a cada 5 min
 *   node src/index.js live-scan --max=10           → limitar a 10 jogos
 */

import chalk from 'chalk';
import { getLiveMatches, collectLiveMatchData } from '../scrapers/sofascore-live.js';
import { LiveInPlayAgent } from '../../squads/betting-analysis/market-agents/LiveInPlayAgent.js';
import { notifyLiveOpportunity } from '../utils/telegram.js';
import { saveLiveOpportunity } from '../utils/obsidian.js';
import { checkSuperbetLiveEligibility } from '../scrapers/superbet.js';

const MIN_PROBABILITY      = parseInt(process.env.LIVE_MIN_PROBABILITY      || '80');
const MIN_CONFIDENCE       = parseInt(process.env.LIVE_MIN_CONFIDENCE       || '80');
const MIN_COMBINED         = parseInt(process.env.LIVE_MIN_COMBINED         || '64'); // prob×conf/100
const DEFAULT_INTERVAL_MIN = parseInt(process.env.LIVE_SCAN_INTERVAL_MINUTES || '15');
const MAX_MATCHES          = parseInt(process.env.LIVE_MAX_MATCHES           || '4');
const MATCH_DELAY_MS       = 12_000; // 12s entre análises — respeita 15 RPM do Gemini

const agent = new LiveInPlayAgent();

// Flag de quota esgotada — evita chamadas desnecessárias à Gemini
let _quotaExhaustedUntil = 0;

// ── Entrada principal ─────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {Map}    opts.sharedNotifiedKeys — Map compartilhado com funnel-live-2t para evitar duplicatas
 */
export async function startLiveScan({ loop = false, intervalMin = DEFAULT_INTERVAL_MIN, maxMatches = MAX_MATCHES, sharedNotifiedKeys } = {}) {
  _printBanner(loop, intervalMin);

  // Scan inicial
  await runLiveScan(maxMatches, sharedNotifiedKeys);

  if (!loop) return;

  // Loop contínuo
  console.log(chalk.gray(`\n⏰ Próximo scan em ${intervalMin} minuto(s)...\n`));

  const intervalMs = intervalMin * 60_000;
  setInterval(async () => {
    await runLiveScan(maxMatches, sharedNotifiedKeys).catch((err) => {
      console.error(chalk.red(`[Live Scan] Erro no loop: ${err.message}`));
    });
    console.log(chalk.gray(`\n⏰ Próximo scan em ${intervalMin} minuto(s)...\n`));
  }, intervalMs);

  await new Promise(() => {}); // mantém processo vivo
}

// ── Ciclo de scan ─────────────────────────────────────────────────────────────
async function runLiveScan(maxMatches, sharedNotifiedKeys) {
  const start = Date.now();
  const ts    = timestamp();

  console.log(chalk.bold.red(`\n[${ts}] 🔴 Iniciando scan de jogos ao vivo...`));

  // 0. Verificar flag de quota — sem chamar a API (evita consumir cota em ping)
  if (Date.now() < _quotaExhaustedUntil) {
    const minRestantes = Math.ceil((_quotaExhaustedUntil - Date.now()) / 60_000);
    console.log(chalk.yellow(`  ⏸  Live scan aguardando cota Gemini (~${minRestantes}min restantes)`));
    return;
  }

  // 1. Buscar jogos em andamento
  const liveMatches = await getLiveMatches();

  if (!liveMatches.length) {
    console.log(chalk.yellow('  ⚠️  Nenhum jogo ao vivo encontrado no momento.'));
    return;
  }

  // 1b. Filtrar apenas jogos disponíveis na Superbet (por competição — sem browser)
  const available = liveMatches.filter((m) => {
    const { allowed, reason } = checkSuperbetLiveEligibility(m.home_team, m.away_team, m.competition);
    if (!allowed) {
      console.log(chalk.gray(`  ⛔ [Superbet] ${m.home_team} vs ${m.away_team} — ${reason}`));
    }
    return allowed;
  });

  if (!available.length) {
    console.log(chalk.yellow('  ⚠️  Nenhum jogo ao vivo disponível na Superbet no momento.'));
    return;
  }

  const limited = available.slice(0, maxMatches);
  console.log(chalk.white(`  📡 ${liveMatches.length} ao vivo  →  ${available.length} na Superbet  →  analisando ${limited.length}`));

  // Exibe lista de jogos encontrados
  for (const m of limited) {
    const score = `${m.score_home}-${m.score_away}`;
    const min   = m.minute != null ? `${m.minute}'` : (m.period || '?');
    console.log(chalk.gray(`    ⚽  [${min}] ${m.home_team} vs ${m.away_team}  (${score})  —  ${m.competition || '?'}`));
  }

  // 2. Analisar cada jogo
  let totalOpportunidades = 0;
  let consecutiveErrors   = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  for (let i = 0; i < limited.length; i++) {
    const match = limited[i];
    const label = `${match.home_team} vs ${match.away_team}`;
    const score = `${match.score_home}-${match.score_away}`;
    const min   = match.minute != null ? `${match.minute}'` : '?';

    console.log(chalk.bold.white(`\n  🔴 [${i + 1}/${limited.length}] ${label}  [${min}]  ${score}`));

    try {
      const opportunities = await analyzeMatch(match, sharedNotifiedKeys);
      consecutiveErrors = 0; // reset ao ter sucesso

      if (opportunities.length) {
        totalOpportunidades += opportunities.length;
        console.log(chalk.bold.green(`    ✅ ${opportunities.length} oportunidade(s) encontrada(s):`));
        for (const o of opportunities) {
          console.log(chalk.green(`       • ${o.mercado}  ${o.probabilidade}%  ${o.recomendacao}`));
        }
        await notifyLiveOpportunity(match._liveData, opportunities).catch(() => {});
      } else {
        console.log(chalk.gray(`    ⏭  Sem oportunidades (critérios não atingidos)`));
      }
    } catch (err) {
      consecutiveErrors++;
      console.error(chalk.red(`    ❌ Erro: ${err.message}`));

      // Circuit breaker apenas para RPD (cota diária) — RPM nunca deve pausar 20 min
      if (err.isQuotaError) {
        _quotaExhaustedUntil = Date.now() + 20 * 60_000;
        const retoma = new Date(_quotaExhaustedUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        console.log(chalk.yellow(`\n  ⏸  Cota diária Gemini esgotada — live scans pausados até ${retoma}`));
        break;
      }
    }

    if (i < limited.length - 1) await sleep(MATCH_DELAY_MS);
  }

  const elapsed = Date.now() - start;
  // Resumo apenas no console interno — sem envio ao Telegram (processo interno silencioso)
  console.log(chalk.bold.red(`\n[${timestamp()}] 🔴 Scan concluído  ·  ${totalOpportunidades} oportunidade(s)  ·  ${Math.round(elapsed / 1000)}s`));
}

// ── Análise individual de um jogo ────────────────────────────────────────────
async function analyzeMatch(match, sharedNotifiedKeys) {
  // Coleta dados ao vivo completos
  const liveData = await collectLiveMatchData(match);
  match._liveData = liveData; // anexa para uso posterior no notify

  // Avalia qualidade dos dados — filtra jogos sem informação útil
  const temStats  = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
  const temForma  = !!(liveData.home?.form && liveData.home.form !== 'N/A' && liveData.home.form.length >= 3);
  const temMinuto = typeof liveData.minuto === 'number';
  const temH2H    = Array.isArray(liveData.h2h) && liveData.h2h.length >= 2;

  // Sem stats ao vivo E sem forma pré-jogo E sem H2H → dados insuficientes para IA
  if (!temStats && !temForma && !temH2H) {
    console.log(chalk.gray(`    ⏭  Dados insuficientes (sem stats, forma ou H2H)`));
    return [];
  }

  if (!temStats) {
    // Sem stats ao vivo: não há dados confiáveis para análise in-play com qualidade
    console.log(chalk.gray(`    ⏭  Sem stats ao vivo — análise live bloqueada (qualidade insuficiente)`));
    return [];
  }

  // Filtra apenas jogos sem tempo útil para apostar:
  //   - Acréscimo do 2T com menos de 2 minutos restantes (>= 93' sem acréscimo declarado)
  //   - Acréscimo do 2T terminou (minutos_restantes <= 1)
  const minuto           = typeof liveData.minuto === 'number' ? liveData.minuto : 0;
  const minutosRestantes = typeof liveData.minutos_restantes === 'number' ? liveData.minutos_restantes : 10;
  const isAcrescimo      = liveData.is_acrescimo;

  if (minutosRestantes <= 1) {
    console.log(chalk.gray(`    ⏭  ${liveData.minuto_label}' — menos de 1 min restante`));
    return [];
  }
  // Bloqueia somente se for acréscimo 2T E restar muito pouco tempo
  if (isAcrescimo && minuto >= 97) {
    console.log(chalk.gray(`    ⏭  ${liveData.minuto_label}' — acréscimo muito avançado`));
    return [];
  }

  // Roda o agente de análise live
  const results = await agent.analyze(liveData);

  // Gate triplo: prob + conf + combined score — somente APOSTAR
  const approved = results.filter((r) => {
    const prob     = r.probabilidade ?? 0;
    const conf     = r.confianca     ?? 0;
    const combined = (prob * conf) / 100;
    if (prob < MIN_PROBABILITY)    return false;
    if (conf < MIN_CONFIDENCE)     return false;
    if (combined < MIN_COMBINED)   return false;
    if (r.recomendacao !== 'APOSTAR') return false; // sem CONSIDERAR
    return true;
  });

  // Dedup unificado — chave idêntica à do funnel-live-2t para evitar envio duplo
  const matchKey = `${match.home_team}_${match.away_team}`;
  const keys     = sharedNotifiedKeys instanceof Map ? sharedNotifiedKeys : new Map();
  const novos = approved.filter((r) => {
    const key = `live_${matchKey}_${r.mercado}_${liveData.placar}`;
    if (keys.has(key)) return false;
    keys.set(key, Date.now());
    return true;
  });

  // Salva oportunidades live no Obsidian
  if (novos.length) {
    saveLiveOpportunity(liveData, novos, 'live');
  }

  return novos;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _printBanner(loop, intervalMin) {
  console.log(chalk.bold.red(`
╔══════════════════════════════════════════════════════╗
║  🔴 BET ANALYSIS SQUAD — LIVE IN-PLAY SCANNER        ║
║  Jogos ao vivo · Análise em tempo real               ║
║  Gate: Prob ≥ ${MIN_PROBABILITY}% · Confiança ≥ ${MIN_CONFIDENCE}%                    ║${loop ? `
║  Modo: Loop a cada ${String(intervalMin).padEnd(2)} minuto(s)                    ║` : `
║  Modo: Scan único                                    ║`}
╚══════════════════════════════════════════════════════╝
  `));
}

function timestamp() {
  return new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
