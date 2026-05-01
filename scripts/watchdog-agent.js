/**
 * watchdog-agent.js — WatchdogAgent v1.0.0
 *
 * Vigilância sistêmica permanente do sistema de apostas.
 *
 * Responsabilidade:
 *   NEGÓCIO — sinal · precisão · dados · PIE · Kill Switches
 *   (infra — processo · internet · disco → health-monitor.js)
 *
 * Estados:  IDLE → WATCH → ALERT → CRITICAL
 * Ciclos:   superficial (1/dia) · padrão (60min) · pos_jogo (30min)
 *           completo (15min) · ao_vivo (5min)
 *
 * Princípio: silêncio com dado = sistema saudável.
 *            alerta sem dado  = ruído → nunca fazer.
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import chalk from 'chalk';
import { enviarAdmin as _routerAdmin, enviarGrupo as _routerGrupo } from '../src/utils/message-router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const DATA       = join(ROOT, 'data');

// ── Caminhos ───────────────────────────────────────────────────────────────────
const PATHS = {
  state:          join(DATA, 'watchdog-state.json'),
  pie:            join(DATA, 'pie.json'),
  pipelineState:  join(DATA, 'pipeline-state.json'),
  bttsTracker:    join(DATA, 'btts-tracker.json'),
  goalsTracker:   join(DATA, 'goals-tracker.json'),
  cornersTracker: join(DATA, 'corners-tracker.json'),
  pipelineHealth: join(DATA, 'pipeline-health.json'),
  radarToday:     join(DATA, 'radar-today.json'),
  snipers: [
    join(ROOT, 'src/utils/btts-sniper.js'),
    join(ROOT, 'src/utils/goals-sniper.js'),
    join(ROOT, 'src/utils/corners-sniper.js'),
  ],
};

// ── Estado inicial ─────────────────────────────────────────────────────────────
const INITIAL_STATE = {
  version:              '1.0.0',
  estado:               'IDLE',
  ciclo:                'superficial',
  ultimo_check:         null,
  alertas_hoje:         0,
  alertas_hoje_data:    null,
  anomalias_pendentes:  [],
  sinais_retidos:       [],
  ultima_auditoria:     null,
  ultima_sugestao:      null,
  ultima_precisao:      { btts: null, goals: null, corners: null, data: null },
  ciclos_executados:    0,
  falhas_detectadas:    0,
  auto_correcoes:       0,
};

// ── Configurações ──────────────────────────────────────────────────────────────
const CFG = {
  MAX_ALERTAS_DIA:      3,             // máximo de mensagens ao grupo por dia (exceto relatório semanal)
  ALERT_COOLDOWN_MS:    15 * 60_000,   // 15 min de cooldown entre o mesmo tipo de alerta (padrão)
  UNRESOLVED_COOLDOWN_MS: 2 * 3_600_000, // 2h de cooldown para alertas de "sinal sem resultado" (evita spam)
  PIE_MAX_SILENCE_H:    48,            // PIE sem atualização → anomalia
  PRECISION_DROP_PP:    3,             // queda de precisão em pp que dispara auditoria
  UNRESOLVED_HOURS:     3,             // sinal sem resultado após X horas → atenção
  KILL_ZONE_CONF:       70,            // confiança abaixo disso = Kill Zone bypass
  SOURCE_TIMEOUT_MS:    3_000,         // timeout para checks de fonte
  HORARIO_JOGO_INICIO:  6,             // hora de início do período de jogos
  HORARIO_JOGO_FIM:     23,            // hora de fim do período de jogos
};

// ── Controle de cooldown por tipo de alerta ────────────────────────────────────
// Persistido em watchdog-state.json — sobrevive a restarts do PM2.
// Sem persistência, cada restart envia o mesmo alerta imediatamente (bug de duplicata).
const alertCooldowns = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────
const tsStr = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const tsShort = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function log(icon, msg, color = 'white') {
  const txt = `[WATCHDOG ${tsStr()}] ${icon} ${msg}`;
  console.log(chalk[color]?.(txt) ?? txt);
}

function _readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  catch { return null; }
}

// ── Estado ─────────────────────────────────────────────────────────────────────
function loadState() {
  const saved = _readJson(PATHS.state);
  const state = saved ? { ...INITIAL_STATE, ...saved } : { ...INITIAL_STATE };

  // Restaura cooldowns persistidos → evita duplicatas após restart do PM2
  if (saved?.alert_cooldowns && typeof saved.alert_cooldowns === 'object') {
    for (const [key, ts] of Object.entries(saved.alert_cooldowns)) {
      alertCooldowns.set(key, ts);
    }
    log('🔄', `Cooldowns restaurados: ${Object.keys(saved.alert_cooldowns).length} entradas`, 'gray');
  }

  return state;
}

function saveState(state) {
  // Persiste cooldowns ativos (expira entradas velhas > 2× cooldown para não inflar o arquivo)
  const cutoff = Date.now() - (CFG.ALERT_COOLDOWN_MS * 2);
  const cooldownsToSave = {};
  for (const [key, ts] of alertCooldowns.entries()) {
    if (ts > cutoff) cooldownsToSave[key] = ts;
  }
  state.alert_cooldowns = cooldownsToSave;

  try { writeFileSync(PATHS.state, JSON.stringify(state, null, 2), 'utf8'); }
  catch (err) { log('⚠️', `Falha ao salvar estado: ${err.message}`, 'yellow'); }
}

// ── Telegram (via message-router) ─────────────────────────────────────────────
/**
 * Envia ao GRUPO com controle de:
 * - Cooldown por tipo de alerta (15min)
 * - Máximo 3 alertas/dia (relatório semanal é exceção — vai fora do limite)
 *
 * O roteamento real (variáveis de ambiente, fallbacks, parse_mode) é gerenciado
 * por message-router.js — watchdog-agent apenas controla taxa de disparo.
 */
async function sendGroup(key, msg, state, { bypassLimit = false } = {}) {
  const now = Date.now();
  const last = alertCooldowns.get(key) || 0;
  // Alertas de "sinal sem resultado" usam cooldown de 2h — ficam pendentes por horas
  // e gerariam spam a cada ciclo de 30-60min sem esse cooldown estendido.
  const cooldown = key.startsWith('unresolved_') ? CFG.UNRESOLVED_COOLDOWN_MS : CFG.ALERT_COOLDOWN_MS;
  if (now - last < cooldown) {
    log('⏭', `Cooldown ativo (${Math.round((cooldown - (now - last)) / 60_000)}min restantes): ${key}`, 'gray');
    return; // cooldown ativo — silêncio
  }

  const today = new Date().toDateString();
  if (!bypassLimit) {
    if (state.alertas_hoje_data !== today) {
      state.alertas_hoje = 0;
      state.alertas_hoje_data = today;
    }
    if (state.alertas_hoje >= CFG.MAX_ALERTAS_DIA) {
      log('⏭', `Alerta suprimido (${state.alertas_hoje}/${CFG.MAX_ALERTAS_DIA} hoje): ${key}`, 'gray');
      return;
    }
    state.alertas_hoje++;
  }

  alertCooldowns.set(key, now);
  log('📤', `Grupo: ${key}`, 'cyan');
  return _routerGrupo(msg);
}

/** Envia ao ADMIN — sem limite diário. Usado para relatório semanal e CRITICAL. */
async function sendAdmin(msg) {
  return _routerAdmin(msg);
}

// ── Determinação de estado operacional ────────────────────────────────────────
function determineState(state) {
  const hour = new Date().getHours();

  // Fora do horário de apostas → IDLE (salvo anomalia pendente)
  if (hour < CFG.HORARIO_JOGO_INICIO || hour >= CFG.HORARIO_JOGO_FIM) {
    return state.anomalias_pendentes?.length > 0 ? 'ALERT' : 'IDLE';
  }

  if (state.anomalias_pendentes?.length > 0) return 'ALERT';
  return 'WATCH';
}

function determineCycle(estado, state) {
  if (estado === 'IDLE')     return 'superficial';
  if (estado === 'CRITICAL') return 'completo';
  if (estado === 'ALERT')    return 'padrao';

  // WATCH — detectar se há sinais disparados recentemente (pós-jogo)
  const hasRecentFired = (tracker) => {
    const last = tracker?.fired_log?.[tracker.fired_log.length - 1];
    if (!last?.fired_at) return false;
    return (Date.now() - new Date(last.fired_at).getTime()) < 3 * 3_600_000;
  };
  const btts  = _readJson(PATHS.bttsTracker);
  const goals = _readJson(PATHS.goalsTracker);
  if (hasRecentFired(btts) || hasRecentFired(goals)) return 'pos_jogo';

  return 'padrao';
}

// ── Módulo 1: Check Superficial (IDLE) ────────────────────────────────────────
// Budget: máximo 200 tokens equivalentes de complexidade.
// Se todos passam: silêncio absoluto.
async function checkSuperficial() {
  log('🔍', 'Check superficial', 'gray');
  const issues = [];

  // 1.1 PIE acessível e não estagnado
  if (!existsSync(PATHS.pie)) {
    issues.push({ key: 'pie_missing', sev: 'ALTA', msg: 'PIE (pie.json) não encontrado — banco de calibração ausente' });
  } else {
    const ageH = (Date.now() - statSync(PATHS.pie).mtimeMs) / 3_600_000;
    if (ageH > CFG.PIE_MAX_SILENCE_H) {
      issues.push({ key: 'pie_stale', sev: 'MEDIA', msg: `PIE sem atualização há ${Math.round(ageH)}h (limite: ${CFG.PIE_MAX_SILENCE_H}h)` });
    }
  }

  // 1.2 Kill Switches — arquivos de sniper presentes
  for (const sp of PATHS.snipers) {
    if (!existsSync(sp)) {
      issues.push({ key: `sniper_missing`, sev: 'ALTA', msg: `Kill Switch ausente: ${sp.split('/').pop()}` });
    }
  }

  // 1.3 Anomalias pendentes não resolvidas
  // (tratadas pelo loop principal — aqui apenas registra para o check superficial)

  // 1.4 SofaScore acessível (check leve — HEAD com timeout 3s)
  try {
    await axios.head('https://api.sofascore.com', { timeout: CFG.SOURCE_TIMEOUT_MS, validateStatus: () => true });
  } catch {
    issues.push({ key: 'src_sofascore', sev: 'MEDIA', msg: 'SofaScore API inacessível durante check superficial' });
  }

  if (issues.length === 0) {
    log('✅', `[WATCHDOG·IDLE·${tsShort()}] PIE✅ KS✅ Fontes✅ → SISTEMA OK`, 'gray');
  }

  return issues;
}

// ── Módulo 2: Check Padrão (WATCH) ────────────────────────────────────────────
// Budget: máximo 500 tokens equivalentes.
// Envia mensagem ao grupo apenas se houver item de atenção confirmado.
async function checkPadrao() {
  log('🔍', 'Check padrão (WATCH)', 'cyan');
  const issues = [];

  // 2.1 Pipeline — verificar se está travado
  const pipeState = _readJson(PATHS.pipelineState);
  if (pipeState?.interrupted && pipeState.stage !== 'done') {
    const savedAt = pipeState.savedAt ? new Date(pipeState.savedAt).getTime() : null;
    const ageMin  = savedAt ? Math.round((Date.now() - savedAt) / 60_000) : null;
    if (ageMin && ageMin > 30) {
      issues.push({
        key:  'pipeline_stuck',
        sev:  'ALTA',
        msg:  `Pipeline travado em "${pipeState.stage}" (último save: ${ageMin}min atrás)`,
      });
    }
  }

  // 2.2 Kill Zone bypass — sinal disparado com confiança < 70% hoje
  const today = new Date().toISOString().split('T')[0];
  const agentTrackers = [
    { name: 'BTTSAgent',    path: PATHS.bttsTracker },
    { name: 'GoalsAgent',   path: PATHS.goalsTracker },
    { name: 'CornersAgent', path: PATHS.cornersTracker },
  ];
  for (const t of agentTrackers) {
    const data = _readJson(t.path);
    if (!data?.fired_log) continue;
    const bypasses = data.fired_log.filter(e =>
      e.fired_at?.startsWith(today) && (e.confianca ?? 100) < CFG.KILL_ZONE_CONF
    );
    if (bypasses.length > 0) {
      issues.push({
        key:    `kill_zone_bypass_${t.name}`,
        sev:    'ALTA',
        msg:    `${t.name} disparou ${bypasses.length} sinal(is) abaixo da Kill Zone (conf < ${CFG.KILL_ZONE_CONF}%) hoje`,
        agent:  t.name,
      });
    }
  }

  // 2.3 Pipeline health — últimas 3 execuções sem partidas em horário de jogo
  const health = _readJson(PATHS.pipelineHealth);
  if (Array.isArray(health) && health.length >= 3) {
    const hour = new Date().getHours();
    const recent3 = health.slice(-3);
    const allEmpty = recent3.every(r => (r.matches_found || 0) === 0 && (r.opportunities || 0) === 0);
    if (allEmpty && hour >= 10 && hour <= 22) {
      issues.push({
        key: 'pipeline_no_matches',
        sev: 'MEDIA',
        msg: `Últimas 3 execuções sem partidas (${hour}h — horário de jogo)`,
      });
    }
  }

  // 2.4 Taxa de aprovação de sinais alta — filtros podem estar fracos
  // (> 60% dos analisados passando = suspeito)
  for (const t of agentTrackers) {
    const data = _readJson(t.path);
    if (!data?.summary) continue;
    const { total_fired = 0, total_blocked = 0 } = data.summary;
    const total = total_fired + total_blocked;
    if (total >= 10 && total_blocked > 0) {
      const approvalRate = total_fired / total * 100;
      if (approvalRate > 60) {
        issues.push({
          key: `high_approval_${t.name}`,
          sev: 'MEDIA',  // BAIXA → só monitorar, não alertar — representado aqui como MEDIA para log
          msg: `${t.name}: taxa de aprovação ${approvalRate.toFixed(0)}% (> 60% — possível filtro fraco)`,
        });
      }
    }
  }

  // 2.5 W1 — Monitor de invocação dos agentes (2026-04-16)
  // Detecta quando um agente fica silencioso enquanto partidas foram analisadas.
  // Critério: sem atividade (fired + blocked) há > 24h E pipeline processou matches.
  // Separa silêncio legítimo (sem odds na liga) de silêncio anômalo (bug/skip).
  const healthLog = _readJson(PATHS.pipelineHealth);
  if (Array.isArray(healthLog) && healthLog.length >= 2) {
    const recentCycles = healthLog.slice(-3);
    const totalMatchesRecent = recentCycles.reduce((s, r) => s + (r.matches_found || 0), 0);
    const hora = new Date().getHours();

    if (totalMatchesRecent > 0 && hora >= 10 && hora <= 22) {
      for (const t of agentTrackers) {
        const data = _readJson(t.path);
        if (!data) continue;

        // Última atividade = max(último fired, último blocked)
        const lastFiredTs  = data.fired_log?.at(-1)?.ts   || data.fired_log?.at(-1)?.fired_at   || null;
        const lastBlockTs  = data.blocked_log?.at(-1)?.ts || null;
        const candidates   = [lastFiredTs, lastBlockTs].filter(Boolean);
        const lastActivity = candidates.length
          ? Math.max(...candidates.map(d => new Date(d).getTime()))
          : null;

        const silenceH = lastActivity ? (Date.now() - lastActivity) / 3_600_000 : null;

        // Agente sem atividade há > 24h com partidas processadas = anomalia
        if (silenceH != null && silenceH > 24) {
          issues.push({
            key:   `agent_silence_${t.name}`,
            sev:   'MEDIA',
            msg:   `${t.name} sem atividade há ${Math.round(silenceH)}h (${totalMatchesRecent} partidas nas últimas ${recentCycles.length} execuções)`,
            agent: t.name,
            tipo:  'AGENTE_SILENCIOSO',
          });
          log('⚠️', `[W1] ${t.name} silencioso há ${Math.round(silenceH)}h`, 'yellow');
        }
      }
    }
  }

  return issues;
}

// ── Módulo 5: Check Pós-Jogo ───────────────────────────────────────────────────
// Budget: máximo 400 tokens equivalentes.
// Detecta sinais disparados sem resultado registrado após X horas.
async function checkPosJogo() {
  log('🔍', 'Check pós-jogo', 'cyan');
  const issues = [];
  const now    = Date.now();

  const agentTrackers = [
    { name: 'BTTSAgent',    path: PATHS.bttsTracker },
    { name: 'GoalsAgent',   path: PATHS.goalsTracker },
    { name: 'CornersAgent', path: PATHS.cornersTracker },
  ];

  for (const t of agentTrackers) {
    const data = _readJson(t.path);
    if (!data?.fired_log) continue;

    const unresolved = data.fired_log.filter(e => {
      if (e.resolved) return false;
      const firedAt = e.fired_at ? new Date(e.fired_at).getTime() : null;
      if (!firedAt) return false;
      const ageH = (now - firedAt) / 3_600_000;
      return ageH > CFG.UNRESOLVED_HOURS && ageH < 24; // entre 3h e 24h sem resolução
    });

    if (unresolved.length > 0) {
      const matches = unresolved.slice(0, 3).map(e => e.match_name || e.match || '(sem nome)').join(', ');
      issues.push({
        key:    `unresolved_${t.name}`,
        sev:    'MEDIA',
        msg:    `${t.name}: ${unresolved.length} sinal(is) sem resultado após ${CFG.UNRESOLVED_HOURS}h: ${matches}`,
      });
    }
  }

  return issues;
}

// ── Módulo 6: Auditoria de Precisão ───────────────────────────────────────────
// Executado: domingo 08h OU gatilho de queda de precisão.
// Budget: máximo 1.000 tokens equivalentes (maior ciclo permitido).
function _calcPrecision(tracker) {
  if (!tracker) return { accuracy: null, fired: 0, resolved: 0, hits: 0 };
  const s = tracker.summary || {};
  return {
    accuracy: s.accuracy  ?? null,
    fired:    s.total_fired   || 0,
    resolved: s.total_resolved || 0,
    hits:     s.hits           || 0,
  };
}

async function runAuditoria(state, { trigger = 'calendar' } = {}) {
  log('📋', `Executando auditoria (trigger: ${trigger})`, 'blue');

  const btts    = _readJson(PATHS.bttsTracker);
  const goals   = _readJson(PATHS.goalsTracker);
  const corners = _readJson(PATHS.cornersTracker);

  const p = {
    btts:    _calcPrecision(btts),
    goals:   _calcPrecision(goals),
    corners: _calcPrecision(corners),
  };

  // Comparar com última auditoria para detectar queda
  const prev = state.ultima_precisao || {};
  const delta = (curr, prevVal) => (curr != null && prevVal != null) ? curr - prevVal : null;

  const dBtts    = delta(p.btts.accuracy,    prev.btts);
  const dGoals   = delta(p.goals.accuracy,   prev.goals);
  const dCorners = delta(p.corners.accuracy, prev.corners);

  const criticalDrops = [];
  if (dBtts    != null && dBtts    < -CFG.PRECISION_DROP_PP) criticalDrops.push({ agent: 'BTTSAgent',    drop: dBtts });
  if (dGoals   != null && dGoals   < -CFG.PRECISION_DROP_PP) criticalDrops.push({ agent: 'GoalsAgent',   drop: dGoals });
  if (dCorners != null && dCorners < -CFG.PRECISION_DROP_PP) criticalDrops.push({ agent: 'CornersAgent', drop: dCorners });

  // Adicionar quedas críticas como anomalias pendentes
  for (const cd of criticalDrops) {
    const key = `precision_drop_${cd.agent}`;
    if (!state.anomalias_pendentes.includes(key)) {
      state.anomalias_pendentes.push(key);
      state.falhas_detectadas++;
    }
  }

  const fmtAcc = (a, d) => {
    if (a == null) return '<i>sem dados</i>';
    const sinal = d == null ? '' : d > 0 ? ` ▲${d.toFixed(1)}pp` : d < 0 ? ` ▼${Math.abs(d).toFixed(1)}pp` : ' →';
    return `${a.toFixed(1)}%${sinal}`;
  };

  const totalFired    = p.btts.fired    + p.goals.fired    + p.corners.fired;
  const totalResolved = p.btts.resolved + p.goals.resolved + p.corners.resolved;
  const totalHits     = p.btts.hits     + p.goals.hits     + p.corners.hits;

  const statusGeral = criticalDrops.length > 0         ? 'ATENÇÃO'
    : (p.btts.accuracy == null && p.goals.accuracy == null) ? 'SEM DADOS'
    : 'SAUDÁVEL';

  const today     = new Date().toLocaleDateString('pt-BR');
  const nextAudit = new Date(Date.now() + 7 * 24 * 3600_000).toLocaleDateString('pt-BR');

  const report = [
    `📋 <b>WatchdogAgent — Relatório Semanal</b>`,
    `<code>${today}</code>`,
    `════════════════════════════════════`,
    `<b>Sinais emitidos:</b>    <code>${totalFired}</code>`,
    `<b>Resolvidos:</b>         <code>${totalResolved}</code>`,
    `<b>Acertos:</b>            <code>${totalHits}</code>`,
    `<b>Retidos (watchdog):</b> <code>${state.sinais_retidos?.length || 0}</code>`,
    `————————————————————————————————————`,
    `<b>Precisão Fire Zone:</b>`,
    `· BTTSAgent:    <code>${fmtAcc(p.btts.accuracy,    dBtts)}</code>`,
    `· GoalsAgent:   <code>${fmtAcc(p.goals.accuracy,   dGoals)}</code>`,
    `· CornersAgent: <code>${fmtAcc(p.corners.accuracy, dCorners)}</code>`,
    `————————————————————————————————————`,
    `<b>Alertas emitidos:</b>   <code>${state.alertas_hoje || 0}</code>`,
    `<b>Falhas detectadas:</b>  <code>${state.falhas_detectadas || 0}</code>`,
    `<b>Auto-correções:</b>     <code>${state.auto_correcoes || 0}</code>`,
    `<b>Ciclos executados:</b>  <code>${state.ciclos_executados || 0}</code>`,
    `————————════════════════════════════`,
    `<b>Status geral:</b> <code>${statusGeral}</code>`,
    `<b>Próxima auditoria:</b> <code>${nextAudit}</code>`,
    `════════════════════════════════════`,
  ].join('\n');

  // Relatório semanal vai ao grupo (é informativo, não reativo) + sempre ao admin
  await sendGroup('relatorio_semanal', report, state, { bypassLimit: true });
  await sendAdmin(report); // message-router evita duplicata se ADMIN_ID === GRUPO_ID

  // Alerta adicional para quedas críticas de precisão
  if (criticalDrops.length > 0) {
    const dropStr = criticalDrops.map(cd => `${cd.agent}: ${cd.drop.toFixed(1)}pp`).join(' · ');
    await sendAdmin(
      `🔴 <b>WatchdogAgent — Queda de Precisão</b>\n<code>${tsShort()}</code>\n` +
      `Agentes afetados: ${dropStr}\nAção: revisar dados de entrada e calibração PIE`
    );
  }

  // Atualizar estado
  state.ultima_precisao = {
    btts:    p.btts.accuracy,
    goals:   p.goals.accuracy,
    corners: p.corners.accuracy,
    data:    new Date().toISOString(),
  };
  state.ultima_auditoria = new Date().toISOString();

  log('✅', `Auditoria concluída. Status: ${statusGeral}`, 'green');
  return { ok: criticalDrops.length === 0, statusGeral };
}

// ── Processamento de anomalias detectadas ──────────────────────────────────────
// Todos os alertas (ALTA e MÉDIA) vão somente ao admin — grupo não recebe avisos internos.
async function handleIssues(issues, state) {
  const now = Date.now();
  for (const issue of issues) {
    const isAlta = issue.sev === 'ALTA';

    // Cooldown — evita alertas duplicados ao admin por ciclo
    const cooldown = issue.key.startsWith('unresolved_') ? CFG.UNRESOLVED_COOLDOWN_MS : CFG.ALERT_COOLDOWN_MS;
    if (now - (alertCooldowns.get(issue.key) || 0) < cooldown) {
      log('⏭', `Cooldown ativo (admin): ${issue.key}`, 'gray');
      continue;
    }
    alertCooldowns.set(issue.key, now);

    if (isAlta) {
      log('🔴', `[ALTA] ${issue.msg}`, 'red');
      state.falhas_detectadas++;

      await sendAdmin(
        `🔴 <b>WatchdogAgent — Alerta</b>\n<code>${tsShort()}</code>\n` +
        `Falha: ${issue.msg}\n` +
        (issue.agent ? `Agente afetado: <code>${issue.agent}</code>\n` : '') +
        `Sinal suspenso: verificar manualmente\n` +
        `Ação imediata: investigar antes do próximo ciclo`
      );

      if (!state.anomalias_pendentes.includes(issue.key)) {
        state.anomalias_pendentes.push(issue.key);
      }

    } else {
      log('⚠️', `[MÉDIA] ${issue.msg}`, 'yellow');
      await sendAdmin(
        `⚠️ <b>WatchdogAgent — Atenção</b>\n<code>${tsShort()}</code>\n` +
        `Item: ${issue.msg}\nAção: monitorar no próximo ciclo`
      );
    }
  }
}

// ── Seleção de intervalo para o próximo ciclo ──────────────────────────────────
function nextIntervalMs(estado, ciclo) {
  const MAP = {
    superficial:   24 * 60 * 60_000,  // 1x por dia
    padrao:        60 * 60_000,        // 60 min
    completo:      15 * 60_000,        // 15 min
    ao_vivo:        5 * 60_000,        //  5 min
    pos_jogo:      30 * 60_000,        // 30 min
  };
  if (estado === 'ALERT' || estado === 'CRITICAL') return 2 * 60_000; // 2 min em anomalia
  return MAP[ciclo] ?? MAP.padrao;
}

// ── Loop principal ─────────────────────────────────────────────────────────────
let _nextTimer = null;

async function runCycle() {
  const state = loadState();
  state.ciclos_executados = (state.ciclos_executados || 0) + 1;

  // ── Auditoria semanal: domingo 08h, pelo menos 6 dias desde a última ──────────
  const now = new Date();
  const isSundayAuditTime = now.getDay() === 0 && now.getHours() === 8 && now.getMinutes() < 10;
  const lastAudit = state.ultima_auditoria ? new Date(state.ultima_auditoria) : null;
  const auditDaysAgo = lastAudit ? (Date.now() - lastAudit.getTime()) / (24 * 3_600_000) : 999;

  if (isSundayAuditTime && auditDaysAgo > 6) {
    await runAuditoria(state, { trigger: 'calendar' });
    saveState(state);
    scheduleNext(state);
    return;
  }

  // ── Determinar estado e ciclo ─────────────────────────────────────────────────
  const estado = determineState(state);
  const ciclo  = determineCycle(estado, state);

  state.estado = estado;
  state.ciclo  = ciclo;
  state.ultimo_check = new Date().toISOString();

  log('🐕', `Estado: ${estado} · Ciclo: ${ciclo} · Ciclo #${state.ciclos_executados}`, 'blue');

  // ── Executar check correspondente ─────────────────────────────────────────────
  let issues = [];

  if (ciclo === 'superficial') {
    issues = await checkSuperficial();

  } else if (ciclo === 'pos_jogo') {
    const posJogo = await checkPosJogo();
    const padrao  = await checkPadrao();
    issues = [...posJogo, ...padrao];

  } else {
    // padrao, completo, ao_vivo
    issues = await checkPadrao();
    if (ciclo === 'completo') {
      const extra = await checkPosJogo();
      issues = [...issues, ...extra];
    }
  }

  // ── Verificar gatilho de auditoria por queda de precisão ──────────────────────
  // (a cada 10 resultados resolvidos, re-verificar precisão)
  const btts  = _readJson(PATHS.bttsTracker);
  const goals = _readJson(PATHS.goalsTracker);
  const totalResolved = (btts?.summary?.total_resolved || 0) + (goals?.summary?.total_resolved || 0);
  const prevResolved  = state._prev_resolved || 0;
  if (totalResolved >= prevResolved + 10 && state.ultima_precisao?.data) {
    log('📊', `${totalResolved - prevResolved} novos resultados → verificando precisão`, 'gray');
    await runAuditoria(state, { trigger: 'precision_check' });
    state._prev_resolved = totalResolved;
  }

  // ── Processar anomalias ───────────────────────────────────────────────────────
  const hasAlta = issues.some(i => i.sev === 'ALTA');

  if (issues.length > 0) {
    await handleIssues(issues, state);
    if (hasAlta) state.estado = 'ALERT';
  } else {
    // Tudo OK — limpar anomalias e silenciar
    if (estado === 'ALERT' && state.anomalias_pendentes.length > 0) {
      log('✅', 'Anomalias anteriores resolvidas → voltando a WATCH/IDLE', 'green');
      state.anomalias_pendentes = [];
    }
    if (ciclo !== 'superficial') {
      log('💚', `Sistema OK — silêncio`, 'gray');
    }
  }

  saveState(state);
  scheduleNext(state);
}

function scheduleNext(state) {
  const ms     = nextIntervalMs(state.estado, state.ciclo);
  const minStr = ms >= 3_600_000
    ? `${Math.round(ms / 3_600_000)}h`
    : `${Math.round(ms / 60_000)}min`;

  log('⏱', `Próximo ciclo: ${state.ciclo} em ${minStr}`, 'gray');
  if (_nextTimer) clearTimeout(_nextTimer);
  _nextTimer = setTimeout(runCycle, ms);
}

// Cleanup gracioso
process.on('SIGTERM', () => { if (_nextTimer) clearTimeout(_nextTimer); process.exit(0); });
process.on('SIGINT',  () => { if (_nextTimer) clearTimeout(_nextTimer); process.exit(0); });

// ── Inicialização ──────────────────────────────────────────────────────────────
log('🐕', 'WatchdogAgent v1.0.0 iniciado — vigilância sistêmica permanente', 'green');
await runCycle();
