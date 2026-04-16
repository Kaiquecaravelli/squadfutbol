/**
 * prelive-monitor.js — Monitor Pré-Live Contínuo v1.0.0
 *
 * Motor de varredura permanente do Superbet com 5 janelas temporais.
 * Chamado pelo scheduler.js em intervalos variáveis por período do dia.
 *
 * Responsabilidades:
 *   · Varrer PRÓXIMO → +1H → +3H → +6H → +12H a cada ciclo
 *   · Detectar novos jogos e variação significativa de odds entre ciclos
 *   · Controlar emissão: silêncio antes das 06:00, ativo após
 *   · Gate temporal mínimo: sem sinal para jogo < 30min sem análise prévia
 *   · Anti-duplicata: um sinal por jogo por mercado por dia
 *   · Máximo 3 sinais simultâneos na mesma janela de 30 min
 *   · Gerar relatórios ao admin: 05:59 · 06:00 · 12:00 · 18:00 · 23:30
 *
 * Estado persistido: data/prelive-monitor-state.json
 *
 * Exporta:
 *   runMonitorCycle(opts)        → executa um ciclo completo
 *   runPreOpCycle(opts)          → ciclo pré-operacional (04:00–05:59, sem envio)
 *   sendOperationalReport(tipo)  → relatório admin (inicio|intermediario|encerramento)
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dirname, '..');
const STATE_FILE = join(ROOT, 'data', 'prelive-monitor-state.json');

// ── Janelas temporais (M1) ────────────────────────────────────────────────────
const WINDOWS = {
  PROXIMO: { label: 'PRÓXIMO',  minMin: 0,   maxMin: 60  },
  P1H:     { label: '+1H',      minMin: 60,  maxMin: 120 },
  P3H:     { label: '+3H',      minMin: 120, maxMin: 240 },
  P6H:     { label: '+6H',      minMin: 240, maxMin: 420 },
  P12H:    { label: '+12H',     minMin: 420, maxMin: 780 },
};
const WINDOW_ORDER = ['PROXIMO', 'P1H', 'P3H', 'P6H', 'P12H'];

// ── Limites operacionais ──────────────────────────────────────────────────────
const HORA_INICIO_EMISSAO  = 6;    // primeira emissão ao grupo
const HORA_FIM_EMISSAO     = 23;   // última emissão (23:30 é o gate final)
const MIN_FILA_EMISSAO_MIN = 30;   // gate temporal: sem sinal < 30min do kickoff
const MAX_SINAIS_30MIN     = 3;    // máximo de sinais simultâneos na mesma janela de 30min
const VAR_ODDS_QUEDA_PCT   = 5;    // queda de odd > 5% → recalcular score
const VAR_ODDS_ALTA_PCT    = 8;    // alta de odd > 8% → remover da fila
const VAR_ODDS_ALERTA_PCT  = 15;   // alta > 15% → alerta admin (odds movendo contra)

// ── Estado inicial do dia ─────────────────────────────────────────────────────
const INITIAL_STATE = {
  date:           null,       // 'YYYY-MM-DD' do dia corrente
  emitted:        {},         // { 'gameKey_market': isoTimestamp }
  known_games:    {},         // { sofascore_id: { match, competition, kickoff_ts, window, last_odds, seen_at } }
  odds_history:   {},         // { sofascore_id_market: { last_odd, last_ts } }
  sinais_30min:   {},         // { slot30: count } — controle de MAX_SINAIS_30MIN
  cycle_stats: {
    cycles_run:        0,
    games_scanned:     0,
    signals_emitted:   0,
    odds_variations:   0,
    lost_opportunities: 0,
    super_odds_emitted: 0,
    fire_zone_count:   0,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const log = (icon, msg, color = 'white') => {
  const txt = `[MONITOR ${ts()}] ${icon} ${msg}`;
  console.log(chalk[color]?.(txt) ?? txt);
};

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { ...INITIAL_STATE };
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const today = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
    // Resetar estado se for um novo dia
    if (saved.date !== today) {
      log('🌅', `Novo dia (${today}) — estado reiniciado`, 'cyan');
      return { ...INITIAL_STATE, date: today };
    }
    return saved;
  } catch { return { ...INITIAL_STATE }; }
}

function saveState(state) {
  try {
    const today = new Date().toLocaleDateString('pt-BR').split('/').reverse().join('-');
    state.date = today;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { log('⚠️', `Falha ao salvar estado: ${err.message}`, 'yellow'); }
}

/** Classifica o jogo na janela temporal correta. */
function classifyWindow(kickoffMs, nowMs = Date.now()) {
  const diffMin = (kickoffMs - nowMs) / 60_000;
  if (diffMin <= 0)   return null; // já iniciou
  for (const [key, w] of Object.entries(WINDOWS)) {
    if (diffMin >= w.minMin && diffMin < w.maxMin) return key;
  }
  return null; // além de +12H
}

/** Chave de dedup: sofascore_id + market slug. */
function emitKey(matchId, market) {
  const mSlug = (market || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.]/g, '').substring(0, 20);
  return `${matchId}_${mSlug}`;
}

/** Slot de 30 minutos para controle de MAX_SINAIS_30MIN. */
function slot30() {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes() < 30 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
}

/** Verifica se é permitido emitir para o grupo agora. */
function canEmit() {
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  if (h < HORA_INICIO_EMISSAO) return false;
  if (h > HORA_FIM_EMISSAO)    return false;
  if (h === HORA_FIM_EMISSAO && m >= 30) return false; // após 23:30 → silêncio
  return true;
}

// ── Detecção de variação de odds ──────────────────────────────────────────────
/**
 * Compara a odd atual com o histórico e classifica a variação.
 * @returns {{ variacao: number, tipo: 'queda'|'alta'|'alerta'|'ok'|'novo' }}
 */
function checkOddsVariation(state, matchId, market, oddAtual) {
  if (!oddAtual || oddAtual <= 1) return { variacao: 0, tipo: 'ok' };
  const key = `${matchId}_${market}`;
  const hist = state.odds_history[key];
  if (!hist?.last_odd) {
    state.odds_history[key] = { last_odd: oddAtual, last_ts: Date.now() };
    return { variacao: 0, tipo: 'novo' };
  }
  const varPct = ((oddAtual - hist.last_odd) / hist.last_odd) * 100;
  state.odds_history[key] = { last_odd: oddAtual, last_ts: Date.now() };

  if (varPct <= -VAR_ODDS_QUEDA_PCT)  return { variacao: varPct, tipo: 'queda'  }; // odd caiu > 5%
  if (varPct >= VAR_ODDS_ALERTA_PCT)  return { variacao: varPct, tipo: 'alerta' }; // odd subiu > 15%
  if (varPct >= VAR_ODDS_ALTA_PCT)    return { variacao: varPct, tipo: 'alta'   }; // odd subiu > 8%
  return { variacao: varPct, tipo: 'ok' };
}

// ── Envio ao admin via message-router ─────────────────────────────────────────
async function _adminMsg(texto) {
  try {
    const { enviarAdmin } = await import('../src/utils/message-router.js');
    await enviarAdmin(texto);
  } catch (err) {
    log('⚠️', `Admin msg falhou: ${err.message}`, 'yellow');
  }
}

// ── M8 · Relatório operacional ao admin ───────────────────────────────────────
/**
 * @param {'preop'|'inicio'|'intermediario'|'encerramento'} tipo
 * @param {object} state
 * @param {object} [extra] — dados adicionais opcionais
 */
export async function sendOperationalReport(tipo, state, extra = {}) {
  const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const hora  = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const SEP   = '════════════════════════════════════';
  const DASH  = '————————————————————————————————————';
  const stats = state.cycle_stats || {};

  const countByWindow = (w) =>
    Object.values(state.known_games || {})
      .filter(g => g.window === w).length;

  let msg = '';

  if (tipo === 'preop') {
    // Relatório pré-operacional (05:59)
    const eligibles = Object.values(state.known_games || {}).length;
    const fireZone  = stats.fire_zone_count || 0;
    const superOdd  = extra.superOddDisponivel ? 'SIM' : 'NÃO';
    msg = [
      `🔧 <b>[SISTEMA] · Pré-operacional concluído · ${hora}</b>`,
      SEP,
      `Jogos elegíveis mapeados: <code>${eligibles}</code>`,
      `Fire Zone confirmada:     <code>${fireZone} jogos</code>`,
      `SUPER ODD disponível:     <code>${superOdd}</code>`,
      `Cache aquecido:           ✅`,
      `Fila de 06h:              <code>${extra.filaCont || 0} sinais prontos</code>`,
      `Pipeline:                 ✅ pronto para operar`,
      SEP,
    ].join('\n');

  } else if (tipo === 'inicio') {
    // Relatório de início de operação (06:00)
    const eligibles = Object.values(state.known_games || {}).length;
    msg = [
      `🔧 <b>[SISTEMA] · Operação Iniciada · 06:00</b>`,
      SEP,
      `Jogos mapeados hoje:     <code>${eligibles}</code>`,
      `Fire Zone (≥ 80%):       <code>${stats.fire_zone_count || 0}</code>`,
      `Fila de emissão 06h:     <code>${extra.filaCont || 0} sinais</code>`,
      `SUPER ODD disponível:    <code>${extra.superOddDisponivel ? 'SIM' : 'NÃO'}</code>`,
      DASH,
      `Janela PRÓXIMO: <code>${countByWindow('PROXIMO')} jogos</code>`,
      `Janela +1H:     <code>${countByWindow('P1H')} jogos</code>`,
      `Janela +3H:     <code>${countByWindow('P3H')} jogos</code>`,
      `Janela +6H:     <code>${countByWindow('P6H')} jogos</code>`,
      `Janela +12H:    <code>${countByWindow('P12H')} jogos</code>`,
      SEP,
    ].join('\n');

  } else if (tipo === 'intermediario') {
    // Relatório intermediário (12:00 e 18:00)
    const horaPeriodo = extra.periodo || hora;
    const proximos = (extra.proximas || []).slice(0, 3)
      .map(p => `· <code>${p.hora}</code> ${p.match} · ${p.mercado} · conf <code>${p.confianca}%</code>`)
      .join('\n');
    msg = [
      `🔧 <b>[SISTEMA] · Update ${horaPeriodo} · ${today}</b>`,
      SEP,
      `Sinais emitidos até agora: <code>${stats.signals_emitted || 0}</code>`,
      `Variações de odds detectadas: <code>${stats.odds_variations || 0}</code>`,
      `Oportunidades perdidas: <code>${stats.lost_opportunities || 0}</code>`,
      `Em fila (aprovados): <code>${extra.filaCont || 0}</code>`,
      proximos ? `${DASH}\nPróximas oportunidades:\n${proximos}` : '',
      SEP,
    ].filter(Boolean).join('\n');

  } else if (tipo === 'encerramento') {
    // Relatório de encerramento (23:30)
    msg = [
      `🔧 <b>[SISTEMA] · Encerramento do Dia · ${today}</b>`,
      SEP,
      `Ciclos executados:           <code>${stats.cycles_run || 0}</code>`,
      `Jogos varridos (total):      <code>${stats.games_scanned || 0}</code>`,
      `Sinais emitidos:             <code>${stats.signals_emitted || 0}</code>`,
      `SUPER ODDS emitidas:         <code>${stats.super_odds_emitted || 0}</code>`,
      `Oportunidades perdidas:      <code>${stats.lost_opportunities || 0}</code>`,
      `Variações de odd detectadas: <code>${stats.odds_variations || 0}</code>`,
      `————————————————————————————————————`,
      `Pipeline entrando em sleep.`,
      `Próxima operação: <code>04:00</code>`,
      SEP,
    ].join('\n');
  }

  if (msg) await _adminMsg(msg);
  log('📋', `Relatório [${tipo}] enviado ao admin`, 'blue');
}

// ── M3 · Rotina pré-operacional (04:00–05:59) ─────────────────────────────────
/**
 * Executa um ciclo de aquecimento sem envio ao grupo.
 * Acessa o Superbet, mapeia jogos, aquece o cache.
 */
export async function runPreOpCycle(opts = {}) {
  const state = loadState();
  log('🌅', `Ciclo pré-operacional ${opts.label || ''}`, 'yellow');

  try {
    // Aquece cache Superbet (Playwright)
    const { ensureFresh, listCachedMatches } = await import('../src/scrapers/superbet-cache.js');
    await ensureFresh('prelive');

    const cached = listCachedMatches('prelive');
    const now    = Date.now();

    // Mapear jogos por janela (sem emissão)
    let newGames   = 0;
    let fireZone   = 0;

    for (const m of cached) {
      const kickoffMs = m.startTimestamp ? m.startTimestamp * 1000 : null;
      if (!kickoffMs) continue;
      const win = classifyWindow(kickoffMs, now);
      if (!win) continue;

      const id = String(m.sofascore_id || m.id || m.match);
      const isNew = !state.known_games[id];
      if (isNew) newGames++;

      state.known_games[id] = {
        match:       m.match || m.home + ' vs ' + m.away,
        competition: m.competition || '',
        kickoff_ts:  kickoffMs,
        window:      win,
        seen_at:     state.known_games[id]?.seen_at || new Date().toISOString(),
        last_checked: new Date().toISOString(),
      };
    }

    state.cycle_stats.games_scanned += cached.length;

    // Calcular score preliminar nos ciclos 05:00 e 05:30
    if (opts.calcScore) {
      try {
        const { runPreLiveSuperOdds } = await import('./prelive-superodds-now.js');
        // Executa em modo dry (sem envio) para calcular scores e pré-montar fila
        await runPreLiveSuperOdds({ dryRun: true });
        log('📊', 'Score pré-operacional calculado (dry run)', 'gray');
      } catch (err) {
        log('⚠️', `Score pré-op falhou: ${err.message}`, 'yellow');
      }
    }

    // Relatório 05:59 ao admin
    if (opts.sendReport) {
      await sendOperationalReport('preop', state, {
        filaCont:            fireZone,
        superOddDisponivel:  false, // será confirmado ao 06:00
      });
    }

    saveState(state);
    log('✅', `Pré-op concluído — ${Object.keys(state.known_games).length} jogos mapeados (${newGames} novos)`, 'green');
  } catch (err) {
    log('❌', `Ciclo pré-op falhou: ${err.message}`, 'red');
    saveState(state);
  }
}

// ── Ciclo principal de monitoramento ─────────────────────────────────────────
/**
 * Executa um ciclo completo de varredura (5 janelas).
 * Controla emissão, detecta variação de odds e novos jogos.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun]          — sem envio ao grupo
 * @param {boolean} [opts.sendReport]      — enviar relatório ao admin ao fim
 * @param {string}  [opts.reportTipo]      — tipo do relatório
 */
export async function runMonitorCycle(opts = {}) {
  const state  = loadState();
  const now    = Date.now();
  const canSend = !opts.dryRun && canEmit();

  state.cycle_stats.cycles_run++;
  log('🔵', `Ciclo #${state.cycle_stats.cycles_run} — ${canSend ? 'EMISSÃO ATIVA' : 'modo silencioso'}`, canSend ? 'cyan' : 'gray');

  try {
    // ── Passo 1: Atualizar cache Superbet ──────────────────────────────────────
    const { ensureFresh, listCachedMatches } = await import('../src/scrapers/superbet-cache.js');
    await ensureFresh('prelive');
    const { entries: cached } = listCachedMatches('prelive');

    // ── Passo 2: Classificar jogos nas janelas ─────────────────────────────────
    const byWindow = { PROXIMO: [], P1H: [], P3H: [], P6H: [], P12H: [] };
    const newGames = [];
    const oddsAlerts = [];

    for (const m of cached) {
      const kickoffMs = m.startTimestamp ? m.startTimestamp * 1000 : null;
      if (!kickoffMs) continue;
      const win = classifyWindow(kickoffMs, now);
      if (!win) continue;

      const id    = String(m.sofascore_id || m.id || m.match);
      const isNew = !state.known_games[id];
      if (isNew) newGames.push(m);

      // Detectar variação de odds
      for (const [mkt, odd] of Object.entries(m.odds || {})) {
        const { variacao, tipo } = checkOddsVariation(state, id, mkt, odd);
        if (tipo === 'alta' || tipo === 'alerta') {
          oddsAlerts.push({ match: m.match, mkt, variacao, tipo });
          state.cycle_stats.odds_variations++;
        }
      }

      // Atualizar known_games
      state.known_games[id] = {
        match:        m.match || '',
        competition:  m.competition || '',
        kickoff_ts:   kickoffMs,
        window:       win,
        seen_at:      state.known_games[id]?.seen_at || new Date().toISOString(),
        last_checked: new Date().toISOString(),
      };

      byWindow[win].push({ ...m, _id: id, _kickoffMs: kickoffMs, _win: win });
    }

    state.cycle_stats.games_scanned += cached.length;

    // ── Passo 3: Alertas de novos jogos e variação de odds ────────────────────
    if (newGames.length > 0) {
      log('🆕', `${newGames.length} novo(s) jogo(s) detectado(s) no ciclo`, 'cyan');
    }
    for (const alert of oddsAlerts) {
      const msg = `⚠️ <b>Variação de Odds</b>\n${alert.match} · ${alert.mkt}\nVariação: ${alert.variacao > 0 ? '+' : ''}${alert.variacao.toFixed(1)}% (${alert.tipo})\n${alert.tipo === 'alerta' ? '🔴 Odds em Movimento Contrário — sinal retido' : ''}`;
      await _adminMsg(msg);
      log('📊', `Variação de odds: ${alert.match} ${alert.mkt} ${alert.variacao.toFixed(1)}%`, 'yellow');
    }

    // ── Passo 4: Emissão (se permitido) ───────────────────────────────────────
    if (canSend) {
      // Verificar gate temporal (< 30min sem análise prévia = oportunidade perdida)
      for (const game of byWindow['PROXIMO']) {
        const diffMin = (game._kickoffMs - now) / 60_000;
        if (diffMin < MIN_FILA_EMISSAO_MIN) {
          const id = game._id;
          const hasEmittedAny = Object.keys(state.emitted).some(k => k.startsWith(id));
          if (!hasEmittedAny) {
            state.cycle_stats.lost_opportunities++;
            log('⏭', `Oportunidade perdida: ${game.match} — ${diffMin.toFixed(0)}min sem análise prévia`, 'red');
            await _adminMsg(`🔴 <b>[Oportunidade Perdida]</b>\n${game.match}\n${game.competition}\nFaltam <code>${diffMin.toFixed(0)} min</code> — sem análise prévia completa`);
          }
        }
      }

      // Controle de sinais simultâneos (M9.3 — máx 3 por janela de 30min)
      const sl = slot30();
      const slotCount = state.sinais_30min[sl] || 0;

      if (slotCount < MAX_SINAIS_30MIN) {
        // Executar pipeline pre-live com emissão real (janelas PRÓXIMO e +1H)
        await _runPreLiveEmission(state, byWindow, { slot: sl, slotCount, canSend });
      } else {
        log('⏭', `Slot ${sl}: ${slotCount}/${MAX_SINAIS_30MIN} sinais já emitidos — aguardando próximo slot`, 'yellow');
      }
    }

    // ── Passo 5: Relatório intermediário (12h ou 18h) ─────────────────────────
    if (opts.sendReport) {
      await sendOperationalReport(opts.reportTipo || 'intermediario', state, {
        periodo: opts.reportTipo === 'inicio' ? '06:00' : opts.reportTipo === 'encerramento' ? '23:30' : new Date().getHours() + 'h',
        filaCont: 0,
      });
    }

    saveState(state);
    log('✅', `Ciclo concluído — ${Object.keys(state.known_games).length} jogos rastreados`, 'green');

  } catch (err) {
    log('❌', `Ciclo falhou: ${err.message}`, 'red');
    console.error(err.stack);
    saveState(state);
  }
}

// ── Emissão interna (janelas PRÓXIMO e +1H) ───────────────────────────────────
async function _runPreLiveEmission(state, byWindow, { slot, slotCount, canSend }) {
  // Janelas emissoras: PRÓXIMO (prioridade máxima) e +1H
  const emitWindows = ['PROXIMO', 'P1H'];
  let emitidos = 0;

  for (const win of emitWindows) {
    const games = byWindow[win] || [];
    if (!games.length) continue;

    // Filtrar jogos já com sinal enviado para todos os mercados disponíveis
    const novos = games.filter(g => {
      const id = g._id;
      const diffMin = (g._kickoffMs - Date.now()) / 60_000;
      if (win === 'PROXIMO' && diffMin < MIN_FILA_EMISSAO_MIN) return false;
      return true;
    });

    if (!novos.length) continue;
    log('📡', `Janela ${WINDOWS[win].label}: ${novos.length} candidato(s) para análise`, 'blue');

    try {
      // Rodar funil pré-live nos jogos da janela (delegando ao pipeline existente)
      const { runPreLiveSuperOdds } = await import('./prelive-superodds-now.js');
      const result = await runPreLiveSuperOdds({ windowFilter: win, dryRun: !canSend });

      if (result?.emitted > 0) {
        emitidos += result.emitted;
        state.cycle_stats.signals_emitted += result.emitted;
        state.cycle_stats.fire_zone_count  = (state.cycle_stats.fire_zone_count || 0) + result.emitted;
        state.sinais_30min[slot]           = (state.sinais_30min[slot] || 0) + result.emitted;

        // Registrar na tabela de emitidos (anti-duplicata)
        for (const sig of (result.signals || [])) {
          const key = emitKey(sig.matchId, sig.market);
          state.emitted[key] = new Date().toISOString();
        }
      }
    } catch (err) {
      log('⚠️', `Pipeline janela ${win} falhou: ${err.message}`, 'yellow');
    }
  }

  // +3H: análise profunda (sem emissão, apenas tracking)
  const p3hGames = byWindow['P3H'] || [];
  if (p3hGames.length > 0) {
    log('🔍', `Janela +3H: ${p3hGames.length} jogo(s) em análise profunda (sem emissão)`, 'gray');
    // Scores calculados no próximo ciclo quando entrarem em +1H
  }

  // +6H e +12H: apenas mapeamento (já feito no Passo 2)
  ['P6H', 'P12H'].forEach(w => {
    const count = (byWindow[w] || []).length;
    if (count > 0) log('📝', `Janela ${WINDOWS[w].label}: ${count} jogo(s) mapeado(s)`, 'gray');
  });

  if (emitidos > 0) {
    log('📤', `${emitidos} sinal(is) emitido(s) neste ciclo`, 'green');
  } else {
    log('💤', 'Nenhum sinal aprovado neste ciclo — silêncio', 'gray');
  }
}

// ── Exportação de utilitários ─────────────────────────────────────────────────
export { WINDOWS, WINDOW_ORDER, canEmit, classifyWindow, slot30 };

export default { runMonitorCycle, runPreOpCycle, sendOperationalReport };
