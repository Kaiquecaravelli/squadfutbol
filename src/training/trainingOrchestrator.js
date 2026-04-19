/**
 * trainingOrchestrator.js — Orquestrador de Treinamento Contínuo
 *
 * Dois modos de execução:
 *
 *   executarCicloTreino()    — ciclo leve (~3–5 min), chamado a cada 10 min quando ocioso
 *     → backfill de resultados pendentes (fecha loops de feedback abertos)
 *     → sniper-protocol (recalibra thresholds se na madrugada/manhã)
 *     → NÃO executa deep-training ou historical-backfill (pesados demais para janelas curtas)
 *
 *   executarSessaoNoturna()  — sessão intensiva (~15–20 min), chamada às 01:30
 *     → backfill estendido (últimos 3 dias)
 *     → sweep-and-learn (fecha todos os ciclos de feedback abertos + admin report)
 *     → sniper-protocol (calibração sniper antes do overnight-trainer das 02:00)
 *     → NÃO sobrepõe com overnight-trainer.js (que inicia às 02:00)
 *
 * Filosofia: agente que treina continuamente gera sinais progressivamente melhores.
 */

import chalk      from 'chalk';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getJanelaAtual } from './idleDetector.js';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = join(ROOT, 'scripts');

// Lock anti-sobreposição
let _treinando = false;

// ── Utilitário ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function log(icon, msg, color = 'white') {
  const line = `[${ts()}] ${icon}  ${msg}`;
  console.log(chalk[color]?.(line) ?? line);
}

/**
 * Executa um script Node.js de forma síncrona com timeout.
 * @param {string} script   — nome do arquivo em scripts/
 * @param {string[]} args
 * @param {number} timeoutMin
 * @returns {boolean}       — true se OK, false se falhou
 */
function runScript(script, args = [], timeoutMin = 10) {
  const fullPath = join(SCRIPTS, script);
  const cmd      = `node "${fullPath}" ${args.join(' ')}`;
  try {
    execSync(cmd, {
      cwd:         ROOT,
      timeout:     timeoutMin * 60_000,
      windowsHide: true,
      stdio:       'inherit',
    });
    return true;
  } catch (e) {
    log('⚠️', `${script} falhou: ${e.message?.split('\n')[0]}`, 'yellow');
    return false;
  }
}

// ── Ciclo leve (a cada 10 min quando ocioso) ──────────────────────────────────

/**
 * Ciclo de treinamento leve — executa em janelas ociosas curtas.
 * Prioriza fechar loops de feedback abertos antes de calibrar.
 */
export async function executarCicloTreino() {
  if (_treinando) {
    log('⏭️', 'Ciclo de treino já em andamento — ignorando', 'yellow');
    return;
  }

  _treinando = true;
  const inicio  = Date.now();
  const janela  = getJanelaAtual();

  log('🧠', `CICLO DE TREINO OCIOSO — janela: ${janela}`, 'cyan');

  try {
    // Passo 1: fechar loops de feedback (sempre, em qualquer janela)
    log('📥', 'Backfill de resultados pendentes...', 'gray');
    runScript('result-backfill.js', [], 8);

    // Passo 2: sniper-protocol — recalibra thresholds por banda de confiança
    // Executa apenas na madrugada/manhã para não interferir com operação diurna
    if (janela === 'MADRUGADA' || janela === 'MANHA') {
      log('🎯', 'Recalibrando thresholds sniper...', 'gray');
      runScript('sniper-protocol.js', [], 5);
    }

    const duracaoS = ((Date.now() - inicio) / 1000).toFixed(1);
    log('✅', `Ciclo concluído em ${duracaoS}s`, 'green');

  } catch (err) {
    log('❌', `Erro no ciclo de treino: ${err.message}`, 'red');
  } finally {
    _treinando = false;
  }
}

// ── Sessão noturna intensiva (01:30) ──────────────────────────────────────────

/**
 * Sessão intensiva de preparação para o overnight-trainer (02:00).
 * Fecha todos os ciclos abertos, calibra sniper, entrega sistema limpo
 * para o overnight-trainer trabalhar com dados frescos às 02:00.
 */
export async function executarSessaoNoturna() {
  if (_treinando) {
    log('⏭️', 'Sessão noturna já em andamento — ignorando', 'yellow');
    return;
  }

  _treinando = true;
  const inicio = Date.now();

  console.log('\n' + '═'.repeat(60));
  log('🌙', 'SESSÃO NOTURNA INTENSIVA — 01:30', 'cyan');
  log('📋', 'Objetivo: fechar todos os ciclos + calibrar antes do overnight-trainer (02:00)', 'gray');
  console.log('═'.repeat(60));

  try {
    // Passo 1: backfill estendido (últimos 3 dias)
    log('📥', '[1/3] Backfill estendido (últimos 3 dias)...', 'cyan');
    runScript('result-backfill.js', ['--days=3'], 15);

    // Passo 2: sweep & learn — fecha todos os loops + admin DM
    log('🔍', '[2/3] Sweep & Learn — varredura completa...', 'cyan');
    runScript('sweep-and-learn.js', [], 10);

    // Passo 3: sniper-protocol — calibração sniper pré-overnight
    log('🎯', '[3/3] Protocolo Sniper — calibração noturna...', 'cyan');
    runScript('sniper-protocol.js', [], 8);

    const minutos = Math.round((Date.now() - inicio) / 60_000);
    console.log('═'.repeat(60));
    log('✅', `Sessão noturna concluída em ${minutos} min — sistema pronto para overnight-trainer (02:00)`, 'green');
    console.log('═'.repeat(60) + '\n');

  } catch (err) {
    log('❌', `Erro na sessão noturna: ${err.message}`, 'red');
  } finally {
    _treinando = false;
  }
}

/**
 * Expõe o estado do lock para uso externo (diagnóstico).
 * @returns {boolean}
 */
export function isTreinando() {
  return _treinando;
}
