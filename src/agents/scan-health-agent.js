/**
 * ScanHealthAgent — Agente de Saúde do Pipeline de Varredura
 *
 * Responsabilidades:
 *  1. Coletar métricas de cada execução do pipeline pré-live
 *  2. Detectar falhas silenciosas (cache, odds, modelo, Telegram)
 *  3. Calcular eficácia e eficiência ao longo do tempo
 *  4. Enviar alertas ao admin via DM quando problemas são detectados
 *  5. Persistir histórico em data/pipeline-health.json
 *
 * Uso:
 *   const health = new ScanHealthAgent();
 *   health.startRun();
 *   // ... pipeline roda ...
 *   health.recordMatch({ match, oddsColetadas, gatesBloqueados, oportunidades });
 *   await health.finishRun({ sent, errors });
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import axios              from 'axios';
import chalk              from 'chalk';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = join(__dirname, '../../data/pipeline-health.json');
const MAX_RUNS   = 200; // histórico máximo

// Limiares de alerta
const THRESHOLDS = {
  oddsCoverageMinPct:    30,   // abaixo de 30% de cobertura de odds → alerta
  noMatchesConsecutive:   3,   // 3 runs sem partidas → alerta
  noOppsConsecutive:     10,   // 10 runs sem oportunidades → alerta
  pipelineMaxMs:      90_000,  // pipeline acima de 90s → alerta de lentidão
  sanityBlockedRatio:   0.80,  // >80% análises bloqueadas por Sanity Gate → modelo ruim
};

export class ScanHealthAgent {
  constructor() {
    this._run = null;
    this._db  = this._load();
  }

  // ── API pública ──────────────────────────────────────────────────────────────

  /** Inicia uma nova execução do pipeline */
  startRun() {
    this._run = {
      ts:              Date.now(),
      matches_found:   0,
      matches_details: [],
      cache_indexed:   0,
      gemini_errors:   0,
      gates: {
        odds_blocked:   0,
        sanity_blocked: 0,
        passed:         0,
      },
      opportunities:   0,
      sent:            0,
      errors:          [],
      duration_ms:     0,
    };
    return this;
  }

  /** Registra quantas partidas foram encontradas nesta execução */
  setMatchesFound(n) {
    if (this._run) this._run.matches_found = n;
    return this;
  }

  /** Registra tamanho do cache Superbet */
  setCacheSize(n) {
    if (this._run) this._run.cache_indexed = n;
    return this;
  }

  /**
   * Registra análise de uma partida individual.
   * @param {object} p
   * @param {string} p.match           — "Home vs Away"
   * @param {string[]} p.oddsColetadas — ['home_win','away_win',...]
   * @param {number}   p.gatesOdds     — qtd bloqueados por Odds Gate
   * @param {number}   p.gatesSanity   — qtd bloqueados por Sanity Gate
   * @param {number}   p.aprovados     — qtd aprovados
   */
  recordMatch({ match, oddsColetadas = [], gatesOdds = 0, gatesSanity = 0, aprovados = 0 }) {
    if (!this._run) return this;
    this._run.matches_details.push({
      match,
      odds_fields: oddsColetadas.length,
      has_goal_odds: oddsColetadas.some(k => k.startsWith('over_') || k.startsWith('under_')),
      gates_odds:   gatesOdds,
      gates_sanity: gatesSanity,
      aprovados,
    });
    this._run.gates.odds_blocked   += gatesOdds;
    this._run.gates.sanity_blocked += gatesSanity;
    this._run.gates.passed         += aprovados;
    return this;
  }

  /** Registra um erro ocorrido durante o pipeline */
  recordError(msg) {
    if (this._run) this._run.errors.push(String(msg).slice(0, 120));
    return this;
  }

  /**
   * Finaliza a execução, calcula métricas, persiste e alerta se necessário.
   * @param {object} p
   * @param {number} p.sent        — mensagens enviadas ao Telegram
   * @param {number} p.opportunities — total de oportunidades aprovadas
   */
  async finishRun({ sent = 0, opportunities = 0 } = {}) {
    if (!this._run) return;

    this._run.duration_ms    = Date.now() - this._run.ts;
    this._run.sent           = sent;
    this._run.opportunities  = opportunities;

    // Calcula cobertura de odds (% de partidas com ≥1 odd coletada)
    const total = this._run.matches_details.length;
    const withOdds = this._run.matches_details.filter(m => m.odds_fields > 0).length;
    this._run.odds_coverage_pct = total > 0 ? Math.round((withOdds / total) * 100) : 0;

    // Salva no histórico
    this._db.runs.push(this._run);
    if (this._db.runs.length > MAX_RUNS) {
      this._db.runs = this._db.runs.slice(-MAX_RUNS);
    }
    this._db.last_run = new Date().toISOString();
    this._db.total_runs   = (this._db.total_runs || 0) + 1;
    this._db.total_sent   = (this._db.total_sent  || 0) + sent;
    this._db.total_opps   = (this._db.total_opps  || 0) + opportunities;
    this._save();

    // Analisa e alerta
    await this._analyze();

    // Log local
    this._logSummary();

    this._run = null;
  }

  /** Retorna relatório de saúde das últimas N execuções */
  getHealthReport(n = 20) {
    const recent = this._db.runs.slice(-n);
    if (!recent.length) return null;

    const totalRuns  = recent.length;
    const withOpps   = recent.filter(r => r.opportunities > 0).length;
    const avgDuration = Math.round(recent.reduce((s, r) => s + (r.duration_ms || 0), 0) / totalRuns / 1000);
    const avgOddsCov  = Math.round(recent.reduce((s, r) => s + (r.odds_coverage_pct || 0), 0) / totalRuns);
    const totalSent   = recent.reduce((s, r) => s + (r.sent || 0), 0);
    const totalErrors = recent.reduce((s, r) => s + (r.errors?.length || 0), 0);

    return {
      runs:             totalRuns,
      opp_rate_pct:     Math.round((withOpps / totalRuns) * 100),
      avg_duration_s:   avgDuration,
      avg_odds_cov_pct: avgOddsCov,
      total_sent:       totalSent,
      total_errors:     totalErrors,
      last_run:         this._db.last_run,
    };
  }

  // ── Análise interna ──────────────────────────────────────────────────────────

  async _analyze() {
    const alerts = [];
    const recent = this._db.runs.slice(-20);
    const run    = this._run || this._db.runs[this._db.runs.length - 1];
    if (!run) return;

    // 1. Cache Superbet vazio ou muito pequeno
    if (run.cache_indexed < 10) {
      alerts.push(`⚠️ Cache Superbet com apenas ${run.cache_indexed} partidas — possível falha no Playwright`);
    }

    // 2. Cobertura de odds baixa
    if (run.matches_found > 0 && run.odds_coverage_pct < THRESHOLDS.oddsCoverageMinPct) {
      alerts.push(`⚠️ Cobertura de odds baixa: ${run.odds_coverage_pct}% (limiar ${THRESHOLDS.oddsCoverageMinPct}%) — seletores HTML desatualizados?`);
    }

    // 3. Sanity Gate bloqueando excessivamente (modelo superestimando)
    const totalAnalyzed = run.gates.passed + run.gates.odds_blocked + run.gates.sanity_blocked;
    if (totalAnalyzed > 3 && run.gates.sanity_blocked / totalAnalyzed > THRESHOLDS.sanityBlockedRatio) {
      alerts.push(`⚠️ Sanity Gate bloqueou ${run.gates.sanity_blocked}/${totalAnalyzed} análises — modelo possivelmente superestimando`);
    }

    // 4. N runs consecutivos sem partidas
    const lastN = recent.slice(-THRESHOLDS.noMatchesConsecutive);
    if (lastN.length === THRESHOLDS.noMatchesConsecutive && lastN.every(r => r.matches_found === 0)) {
      alerts.push(`🚨 ${THRESHOLDS.noMatchesConsecutive} varreduras consecutivas sem partidas — verificar SofaScore ou janela de horário`);
    }

    // 5. N runs consecutivos sem oportunidades (havendo partidas)
    const lastNoOpps = recent.slice(-THRESHOLDS.noOppsConsecutive);
    if (
      lastNoOpps.length === THRESHOLDS.noOppsConsecutive &&
      lastNoOpps.every(r => r.opportunities === 0 && r.matches_found > 0)
    ) {
      alerts.push(`🚨 ${THRESHOLDS.noOppsConsecutive} varreduras sem oportunidades com partidas disponíveis — gates muito restritivos?`);
    }

    // 6. Pipeline lento
    if (run.duration_ms > THRESHOLDS.pipelineMaxMs) {
      alerts.push(`⏱️ Pipeline lento: ${Math.round(run.duration_ms / 1000)}s (limiar ${THRESHOLDS.pipelineMaxMs / 1000}s)`);
    }

    // 7. Erros críticos
    if (run.errors.length > 0) {
      alerts.push(`❌ ${run.errors.length} erro(s) na execução: ${run.errors[0]}`);
    }

    if (alerts.length) {
      await this._sendAdminAlert(alerts, run);
    }
  }

  async _sendAdminAlert(alerts, run) {
    const token   = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.TELEGRAM_ADMIN_USER_ID;
    if (!token || !adminId) return;

    const ts   = new Date(run.ts).toLocaleString('pt-BR');
    const lines = [
      `🤖 <b>ScanHealthAgent — Alerta</b>`,
      `<i>${ts}</i>`,
      ``,
      ...alerts.map(a => `• ${a}`),
      ``,
      `📊 Partidas: ${run.matches_found} | Odds: ${run.odds_coverage_pct}% | Enviadas: ${run.sent} | ${Math.round(run.duration_ms / 1000)}s`,
    ];

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    adminId,
      text:       lines.join('\n'),
      parse_mode: 'HTML',
    }).catch(() => {});
  }

  _logSummary() {
    const run = this._db.runs[this._db.runs.length - 1];
    if (!run) return;
    const dur = (run.duration_ms / 1000).toFixed(1);
    console.log(chalk.gray(
      `  [HealthAgent] partidas:${run.matches_found} | odds:${run.odds_coverage_pct}%` +
      ` | gate✅:${run.gates.passed} gate🚫:${run.gates.odds_blocked + run.gates.sanity_blocked}` +
      ` | enviadas:${run.sent} | ${dur}s`
    ));
  }

  // ── Persistência ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (existsSync(DB_PATH)) return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    } catch {}
    return { runs: [], total_runs: 0, total_sent: 0, total_opps: 0, last_run: null };
  }

  _save() {
    try {
      writeFileSync(DB_PATH, JSON.stringify(this._db, null, 2));
    } catch (e) {
      console.error(chalk.red(`[HealthAgent] Erro ao salvar: ${e.message}`));
    }
  }
}
