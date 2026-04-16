/**
 * escalation-protocol.js — Protocolo de Mínimo Diário Garantido (Módulo 1)
 *
 * Hierarquia de 6 níveis. Quando o pipeline normal está sem sinal aprovado
 * na fila, este protocolo é acionado em ordem sequencial até encontrar
 * uma oportunidade ou entregar análise educacional.
 *
 * Níveis:
 *   1 — Mercados primários, gate padrão (≥ 80% / ≥ 75%)
 *   2 — Mercados primários, gate reduzido (≥ 72%)        [flag: Gate Reduzido]
 *   3 — Ligas estendidas (whitelist PIE ≥ 65%)           [flag: Liga Estendida]
 *   4 — Padrões alternativos via histórico PIE
 *   5 — SUPER ODD composta (≥ 3 seleções com ≥ 72%)     [flag: SUPER ODD Alternativa]
 *   6 — Análise educacional (último recurso)
 *
 * NOTA DE SEGURANÇA: O Kill Zone (60–70%) nunca é desativado.
 * Histórico de 880+ amostras confirma 0% de precisão nessa faixa.
 * Gate mínimo absoluto em todos os níveis: 71% (imediatamente acima do Kill Zone).
 */

import { getDailyCount, getDailyStatus } from './daily-counter.js';
import { sendEducationalAnalysis, notifyAdminEscalation } from './educational-analysis.js';
import { runPreLiveSuperOdds } from './prelive-superodds-now.js';

// ── Thresholds por nível (Módulo 3.2) ────────────────────────────────────────
// Kill Zone (60–70%) nunca é desativado — Math.max(71, value) no lazy getter do funil.
// Thresholds abaixo de 71% são efetivamente elevados para 71% pelo Kill Zone.
// Valores definidos aqui refletem a intenção operacional — o Kill Zone aplica o piso.
const LEVEL_GATES = {
  1: { minProb: 80,  minConf: 75,  label: 'Padrão',             flag: null },
  2: { minProb: 72,  minConf: 72,  label: 'Gate Reduzido',      flag: '[Gate Reduzido · 72%]' },
  3: { minProb: 72,  minConf: 70,  label: 'Liga Estendida',     flag: '[Liga Estendida · PIE 65–75%]' },
  4: { minProb: 72,  minConf: 70,  label: 'Padrão Estendido',   flag: '[Padrão Estendido]' },
  5: { minProb: 71,  minConf: 68,  label: 'SUPER ODD',          flag: '[SUPER ODD Alternativa]' },
  // Nível emergência (22h+): gate máximo relaxado — Kill Zone ainda aplica piso 71%
  6: { minProb: 71,  minConf: 65,  label: 'Emergência',         flag: '[Emergência · Gate Mínimo]' },
};

// Variável de controle de execução concorrente
let _escalationRunning = false;

/**
 * Executa varredura com o gate do nível especificado.
 * Injeta thresholds via process.env antes de chamar runPreLiveSuperOdds
 * (funnel-pre-live.js lê process.env em tempo de execução via lazy getters).
 *
 * @param {number} level - 1..5
 * @returns {Promise<number>} - quantos sinais foram encontrados/enviados
 */
async function runScanAtLevel(level) {
  const gate = LEVEL_GATES[level];
  if (!gate) return 0;

  // Salva valores anteriores
  const prevProb = process.env.PRE_LIVE_MIN_PROBABILITY;
  const prevConf = process.env.PRE_LIVE_MIN_CONFIDENCE;

  // Ativa gate do nível
  process.env.PRE_LIVE_MIN_PROBABILITY = String(gate.minProb);
  process.env.PRE_LIVE_MIN_CONFIDENCE  = String(gate.minConf);

  // Nível 3: habilitar ligas estendidas (bypassa dead-league filter para ligas ≥ 65% PIE)
  const prevExtended = process.env.PRE_LIVE_EXTENDED_LEAGUES;
  if (level === 3) process.env.PRE_LIVE_EXTENDED_LEAGUES = '1';

  // Flag de escalada (injetada no contexto para o Telegram saber que está em modo reduzido)
  if (gate.flag) process.env.PRE_LIVE_ESCALATION_FLAG = gate.flag;

  console.log(`[Escalada] Nível ${level} (${gate.label}) — gate ${gate.minProb}%/${gate.minConf}%`);

  try {
    await runPreLiveSuperOdds();

    // Mede se algum sinal novo foi enviado verificando aumento no contador
    const countAfter = getDailyCount();
    return countAfter;
  } finally {
    // Restaura valores anteriores
    if (prevProb !== undefined) process.env.PRE_LIVE_MIN_PROBABILITY = prevProb;
    else                         delete process.env.PRE_LIVE_MIN_PROBABILITY;

    if (prevConf !== undefined) process.env.PRE_LIVE_MIN_CONFIDENCE = prevConf;
    else                         delete process.env.PRE_LIVE_MIN_CONFIDENCE;

    if (level === 3) {
      if (prevExtended !== undefined) process.env.PRE_LIVE_EXTENDED_LEAGUES = prevExtended;
      else                             delete process.env.PRE_LIVE_EXTENDED_LEAGUES;
    }

    delete process.env.PRE_LIVE_ESCALATION_FLAG;
  }
}

/**
 * Protocolo completo de escalada — ativado pelos alertas de horário.
 *
 * @param {object} opts
 * @param {number} opts.startLevel   - nível a partir do qual iniciar (1–6)
 * @param {number} opts.target       - meta de análises (default: 3)
 * @param {string} opts.triggerTime  - horário que ativou (ex: "12:00")
 * @returns {Promise<void>}
 */
export async function runEscalationProtocol({ startLevel = 1, target = 3, triggerTime = '' } = {}) {
  if (_escalationRunning) {
    console.log('[Escalada] ⏭ Protocolo já em execução — ignorando disparo concorrente');
    return;
  }
  _escalationRunning = true;

  try {
    let countBefore = getDailyCount();

    console.log(`\n[Escalada] 🚨 Protocolo ativado às ${triggerTime || new Date().toLocaleTimeString('pt-BR')}`);
    console.log(`[Escalada] Análises enviadas hoje: ${countBefore} | Meta: ${target}`);

    if (countBefore >= target) {
      console.log('[Escalada] ✅ Meta já atingida — protocolo desnecessário');
      return;
    }

    // Notifica admin
    await notifyAdminEscalation({
      level:  startLevel,
      count:  countBefore,
      target,
      reason: `Alerta automático ${triggerTime}`,
    }).catch(() => {});

    // Tenta cada nível em ordem até atingir a meta ou esgotar os níveis
    for (let level = startLevel; level <= 5; level++) {
      if (getDailyCount() >= target) {
        console.log(`[Escalada] ✅ Meta atingida no Nível ${level - 1}`);
        break;
      }

      console.log(`[Escalada] → Tentando Nível ${level}...`);
      await runScanAtLevel(level);

      const countAfter = getDailyCount();
      if (countAfter > countBefore) {
        console.log(`[Escalada] ✅ Nível ${level} encontrou ${countAfter - countBefore} novo(s) sinal(is)`);
        countBefore = countAfter;

        // Aguarda 2 minutos antes de tentar o próximo nível (rate limit + dedup)
        if (countAfter < target) await sleep(2 * 60_000);
      } else {
        console.log(`[Escalada] ℹ️  Nível ${level} sem novos sinais`);
      }
    }

    // Nível 6 — análise educacional como último recurso
    const finalCount = getDailyCount();
    if (finalCount < target) {
      console.log('[Escalada] → Nível 6: análise educacional');
      await sendEducationalAnalysis({
        reasons: [
          `Todos os 5 níveis de varredura executados sem sinal aprovado`,
          `Grade atual composta por ligas fora da whitelist de qualidade`,
          `Sistema em modo observação — calibração em andamento`,
        ],
      });
    }

    const finalStatus = getDailyStatus();
    console.log(`\n[Escalada] 📊 Resultado: ${finalStatus.total}/${target} análises (${finalStatus.status})\n`);
  } catch (err) {
    console.error(`[Escalada] ❌ Erro no protocolo: ${err.message}`);
  } finally {
    _escalationRunning = false;
  }
}

// ── Verificação pontual de horário ────────────────────────────────────────────

/**
 * Verifica o estado do contador no horário especificado e dispara
 * o nível de escalada correspondente conforme Módulo 4.3.
 *
 * Horários e condições (Módulo 4.3):
 *   12:00 → count = 0   → Nível 2 (gate 72%) + alerta admin
 *   15:00 → count < 2   → Nível 3 (liga estendida) + alerta admin
 *   18:00 → count < 2   → Nível 3/4 URGENTE
 *   20:00 → count < 3   → Nível 5 CRÍTICO
 *   21:00 → count < 3   → Nível 5 CRÍTICO
 *   22:00 → count < 3   → Emergência (gate 71% floor) + qualquer liga elegível
 *   23:59 → sempre      → Registro final do dia (sem escalada)
 *
 * @param {string} hour - '12:00' | '15:00' | '18:00' | '20:00' | '21:00' | '22:00' | '23:59'
 */
export async function checkAndEscalate(hour) {
  const { total, target } = getDailyStatus();

  const rules = {
    '12:00': { threshold: 0,    level: 2, description: 'Nenhuma análise até 12h → Nível 2 (gate 72%)' },
    '15:00': { threshold: 1,    level: 3, description: 'Menos de 2 até 15h → Nível 3 (liga estendida)' },
    '18:00': { threshold: 1,    level: 4, description: '⚠️ URGENTE: menos de 2 até 18h → Nível 4' },
    '20:00': { threshold: 2,    level: 5, description: '🚨 CRÍTICO: menos de 3 até 20h → Nível 5' },
    '21:00': { threshold: 2,    level: 5, description: '🚨 CRÍTICO: menos de 3 até 21h → Nível 5+6' },
    '22:00': { threshold: 2,    level: 6, description: '🆘 EMERGÊNCIA: menos de 3 até 22h → gate mínimo' },
    '23:59': { threshold: null, level: null, description: 'Registro final do dia' },
  };

  const rule = rules[hour];
  if (!rule) return;

  // 23:59 — apenas registra, não escala
  if (hour === '23:59') {
    const status = getDailyStatus();
    const label  = status.total >= target ? 'META ATINGIDA' : 'DIA INCOMPLETO';
    console.log(`[Counter] 📊 Fechamento do dia: ${status.total}/${target} análises — [${label}]`);
    return;
  }

  const needsEscalation = total <= rule.threshold;
  console.log(`\n[Escalada] ⏰ Verificação ${hour}: ${total}/${target} análises enviadas`);

  if (needsEscalation) {
    console.log(`[Escalada] ⚡ ${rule.description}`);
    await runEscalationProtocol({
      startLevel:  rule.level,
      target,
      triggerTime: hour,
    });
  } else {
    console.log(`[Escalada] ✅ Contagem adequada (${total}) — sem escalada necessária`);
  }
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
