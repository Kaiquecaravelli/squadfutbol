/**
 * Funil LIVE 2T — Análise de jogos ao vivo no 2° Tempo (min 46+)
 *
 * Gate: Prob ≥ 80% E Confiança ≥ 80% E Score combinado ≥ 64
 * Somente recomendação APOSTAR — sem "CONSIDERAR"
 * Requer stats ao vivo (sem stats → análise bloqueada)
 */

import chalk from 'chalk';
import { getLiveMatches, collectLiveMatchData } from '../scrapers/sofascore-live.js';
import { Live2TAgent } from '../../squads/betting-analysis/market-agents/Live2TAgent.js';
import { saveLiveOpportunity } from '../utils/obsidian.js';
import { checkSuperbetLiveEligibility } from '../scrapers/superbet.js';

const MIN_PROBABILITY   = parseInt(process.env.LIVE2T_MIN_PROBABILITY   || '80');
const MIN_CONFIDENCE    = parseInt(process.env.LIVE2T_MIN_CONFIDENCE    || '80');
const MIN_COMBINED      = parseInt(process.env.LIVE2T_MIN_COMBINED      || '64'); // prob×conf/100
const MAX_MATCHES       = parseInt(process.env.LIVE2T_MAX_MATCHES       || '5');
const MATCH_DELAY_MS    = 12_000; // 12s entre análises — respeita 15 RPM do Gemini

const agent = new Live2TAgent();

// Flag de quota esgotada — evita chamadas desnecessárias
let _quotaExhaustedUntil = 0;

// ── Entrada principal ──────────────────────────────────────────────────────────
/**
 * Executa um scan de jogos ao vivo no 2° Tempo.
 * @param {Map} notifiedKeys — Map de chaves já notificadas (key → timestamp)
 * @returns {Array} oportunidades encontradas
 */
export async function runLive2TFunnel(notifiedKeys = new Map()) {
  // Verifica quota antes de iniciar
  if (Date.now() < _quotaExhaustedUntil) {
    const min = Math.ceil((_quotaExhaustedUntil - Date.now()) / 60_000);
    console.log(chalk.yellow(`  [LIVE-2T] ⏸ Quota Gemini esgotada (~${min}min restantes)`));
    return [];
  }

  // Busca jogos ao vivo
  const allLive = await getLiveMatches();
  if (!allLive.length) {
    console.log(chalk.gray(`  [LIVE-2T] Nenhum jogo ao vivo`));
    return [];
  }

  // Filtra apenas jogos disponíveis na Superbet (por competição — sem browser)
  const liveFiltrado = allLive.filter((m) => {
    const { allowed, reason } = checkSuperbetLiveEligibility(m.home_team, m.away_team, m.competition);
    if (!allowed) {
      console.log(chalk.gray(`  ⛔ [LIVE-2T] ${m.home_team} vs ${m.away_team} — ${reason}`));
    }
    return allowed;
  });

  if (liveFiltrado.length < allLive.length) {
    console.log(chalk.gray(`  [LIVE-2T] 🔎 Superbet: ${liveFiltrado.length}/${allLive.length} jogos elegíveis`));
  }

  // Filtra apenas jogos no 2° Tempo (minuto >= 46)
  const segundoTempo = liveFiltrado.filter((m) => {
    const min    = m.minute ?? 0;
    const period = (m.period || '').toLowerCase();
    const is2T   = period.includes('2nd') || period.includes('second') || min >= 46;
    return is2T && !period.includes('halftime');
  });

  if (!segundoTempo.length) {
    console.log(chalk.gray(`  [LIVE-2T] Nenhum jogo no 2° Tempo disponível na Superbet`));
    return [];
  }

  const limited = segundoTempo.slice(0, MAX_MATCHES);
  console.log(chalk.bold.yellow(`  [LIVE-2T] 🟡 ${segundoTempo.length} jogo(s) no 2T (Superbet) → analisando ${limited.length}`));

  for (const m of limited) {
    const min   = m.minute != null ? `${m.minute}'` : '?';
    const score = `${m.score_home}-${m.score_away}`;
    console.log(chalk.gray(`    ⚽  [${min}] ${m.home_team} vs ${m.away_team}  (${score})`));
  }

  const allOpportunities = [];
  let consecutiveErrors  = 0;

  for (let i = 0; i < limited.length; i++) {
    const match = limited[i];

    try {
      const opps = await _analyzeMatch(match, notifiedKeys);
      consecutiveErrors = 0;

      if (opps.length) {
        allOpportunities.push(...opps);
        console.log(chalk.bold.green(`    ✅ [LIVE-2T] ${match.home_team} vs ${match.away_team}: ${opps.length} oportunidade(s)`));
        for (const o of opps) {
          console.log(chalk.green(`       • ${o.mercado}  ${o.probabilidade}%  ${o.recomendacao}`));
        }
      } else {
        console.log(chalk.gray(`    ⏭  [LIVE-2T] ${match.home_team} vs ${match.away_team}: sem oportunidades`));
      }
    } catch (err) {
      consecutiveErrors++;
      console.error(chalk.red(`    ❌ [LIVE-2T] ${match.home_team}: ${err.message}`));

      // Só ativa circuit breaker se for RPD (cota diária real), não RPM
      if (err.isQuotaError || consecutiveErrors >= 3) {
        _quotaExhaustedUntil = Date.now() + 20 * 60_000;
        const retoma = new Date(_quotaExhaustedUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        console.log(chalk.yellow(`\n  [LIVE-2T] ⏸ Quota esgotada — pausado até ${retoma}`));
        break;
      }
    }

    if (i < limited.length - 1) await sleep(MATCH_DELAY_MS);
  }

  return allOpportunities;
}

// ── Análise individual ─────────────────────────────────────────────────────────
async function _analyzeMatch(match, notifiedKeys) {
  const liveData = await collectLiveMatchData(match);

  // Requer stats ao vivo — sem dados em tempo real a análise 2T não é confiável
  const temStats = !!(liveData.live_stats?.chutes_alvo_casa != null || liveData.xg_home != null);
  const temForma = !!(liveData.home?.form && liveData.home.form.length >= 3);
  const temH2H   = Array.isArray(liveData.h2h) && liveData.h2h.length >= 2;

  if (!temStats) {
    // Sem stats ao vivo: bloqueia análise 2T (dados pré-jogo não são suficientes para live)
    console.log(chalk.gray(`    ⏭  [LIVE-2T] ${liveData.match}: sem stats ao vivo — bloqueado`));
    return [];
  }
  if (!temForma && !temH2H) {
    console.log(chalk.gray(`    ⏭  [LIVE-2T] ${liveData.match}: dados insuficientes`));
    return [];
  }

  // Filtros temporais
  const minuto           = typeof liveData.minuto === 'number' ? liveData.minuto : 0;
  const minutosRestantes = typeof liveData.minutos_restantes === 'number' ? liveData.minutos_restantes : 10;
  const isAcrescimo      = liveData.is_acrescimo;

  if (minutosRestantes <= 5) return []; // menos de 5 min: sem tempo para entrada segura
  if (isAcrescimo && minuto >= 97) return [];
  if (minuto < 46) return [];

  // Roda o agente especializado em 2T
  const results = await agent.analyze(liveData);

  // Gate triplo: prob + conf + combined score (prob×conf/100)
  const approved = results.filter((r) => {
    const prob     = r.probabilidade ?? 0;
    const conf     = r.confianca     ?? 0;
    const combined = (prob * conf) / 100;
    if (prob < MIN_PROBABILITY)                                     return false;
    if (conf < MIN_CONFIDENCE)                                      return false;
    if (combined < MIN_COMBINED)                                    return false;
    if (r.recomendacao !== 'APOSTAR')                               return false; // sem CONSIDERAR
    return true;
  });

  if (!approved.length) return [];

  // Dedup: chave = times + mercado + placar (muda a cada gol marcado)
  const matchKey = `${match.home_team}_${match.away_team}`;
  const novos = approved.filter((r) => {
    const key = `live_${matchKey}_${r.mercado}_${liveData.placar}`;
    if (notifiedKeys.has(key)) return false;
    notifiedKeys.set(key, Date.now());
    return true;
  });

  // Salva oportunidades live 2T no Obsidian
  if (novos.length) {
    saveLiveOpportunity(liveData, novos, 'live-2t');
  }

  // Anexa dados do jogo para uso posterior (Telegram notify)
  return novos.map((r) => ({ ...r, _liveData: liveData }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
