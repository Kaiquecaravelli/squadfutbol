/**
 * overnight-trainer.js — Treinamento Noturno Autônomo + Protocolo Sniper
 *
 * Roda como processo PM2 separado. Toda madrugada:
 *
 *   02:00 → Coleta +7 dias de dados históricos reais (SofaScore)
 *   03:00 → Deep Training 9 fases (padrões, lift, calibração Poisson)
 *   04:00 → Training Cycle semanal (valida progresso vs metas)
 *   04:30 → Protocolo Sniper — avalia precisão por banda de confiança
 *   05:00 → Debriefing completo gravado em logs/training-progress.jsonl
 *
 * Filosofia Sniper: "One Shot, One Kill"
 *   Agentes só disparam quando o alvo está 100% confirmado.
 *   Um GREEN preciso vale mais que cinco sinais duvidosos.
 *   Abstençao é disciplina, não fraqueza.
 *
 * Meta: chegar a 98% de assertividade nos mercados Tier-1.
 * Progresso esperado: +2~4pp por semana de treinamento consistente.
 *
 * NÃO interfere com o scheduler principal (sem pipelines, sem Telegram).
 */

import 'dotenv/config';
import cron  from 'node-cron';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isObsidianConfigured, updateTreinamentoNoturno, rebuildDashboard } from '../src/utils/obsidian.js';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const LOG_DIR = join(ROOT, 'logs');
const PROG    = join(LOG_DIR, 'training-progress.jsonl');

mkdirSync(LOG_DIR, { recursive: true });

// Metas de acurácia por mercado
const TARGETS = {
  'Over 1.5':         98,
  'BTTS':             95,
  'Over 2.5':         92,
  'Over Corners 6.5': 90,
  'Over Corners 7.5': 85,
  'YC 2.5':           85,
  'YC 3.5':           75,
  'Over 3.5':         70,
};

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function log(icon, msg, color = 'white') {
  const line = `[${ts()}] ${icon}  ${msg}`;
  console.log(chalk[color]?.(line) ?? line);
}

function logProgress(data) {
  try {
    writeFileSync(PROG, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n', { flag: 'a' });
  } catch {}
}

// ── Executa script com timeout e retorna sucesso/falha ───────────────────────
function runScript(scriptPath, args = [], timeoutMin = 60) {
  const cmd = `node "${scriptPath}" ${args.join(' ')}`;
  log('⚙️', `Executando: ${scriptPath.split(/[\\/]/).pop()} ${args.join(' ')}`, 'cyan');
  try {
    execSync(cmd, {
      cwd:         ROOT,
      timeout:     timeoutMin * 60 * 1000,
      windowsHide: true,
      stdio:       'inherit',
    });
    return true;
  } catch (e) {
    log('❌', `Falhou: ${e.message?.split('\n')[0]}`, 'red');
    return false;
  }
}

// ── Lê acurácia atual do PIE ──────────────────────────────────────────────────
function readCurrentAccuracy() {
  try {
    const pie = JSON.parse(readFileSync(join(ROOT, 'data/pie.json'), 'utf8'));
    const cal = pie.calibration || {};
    const result = {};
    for (const [market, target] of Object.entries(TARGETS)) {
      const c = cal[market];
      if (c && c.total >= 30) {
        const acc = Math.round((c.hits / c.total) * 100);
        result[market] = { acc, target, gap: target - acc, samples: c.total };
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ── Fase 1: Expansão histórica (+7 dias do SofaScore) ────────────────────────
async function fase1_expandirHistorico() {
  log('📥', '═══ FASE 1 — Expansão Histórica (+7 dias) ═══', 'cyan');
  const script = join(ROOT, 'scripts/historical-backfill.js');
  const ok = runScript(script, ['--days=7'], 45);
  log(ok ? '✅' : '⚠️', ok ? 'Histórico expandido' : 'Backfill parcial — continuando', ok ? 'green' : 'yellow');
  return ok;
}

// ── Fase 2: Deep Training (9 fases) ─────────────────────────────────────────
async function fase2_deepTraining() {
  log('🧠', '═══ FASE 2 — Deep Training (9 fases) ═══', 'cyan');
  const before = readCurrentAccuracy();
  const script = join(ROOT, 'scripts/deep-training.js');
  const ok = runScript(script, ['--reset-rules'], 50);

  if (ok) {
    const after = readCurrentAccuracy();
    log('📊', 'Variação de acurácia após deep training:', 'green');
    for (const [market, aft] of Object.entries(after)) {
      const bef = before[market];
      const delta = bef ? aft.acc - bef.acc : 0;
      const arrow = delta > 0 ? `+${delta}pp ↑` : delta < 0 ? `${delta}pp ↓` : '—';
      const color = delta > 0 ? 'green' : delta < 0 ? 'red' : 'gray';
      log('  📈', `${market.padEnd(20)} ${String(aft.acc).padStart(3)}%  (meta: ${aft.target}%  gap: ${aft.gap}pp)  ${arrow}`, color);
    }
    logProgress({ fase: 'deep-training', before, after });
  }
  return ok;
}

// ── Fase 3: Training Cycle semanal ──────────────────────────────────────────
async function fase3_trainingCycle() {
  log('🔄', '═══ FASE 3 — Training Cycle Semanal ═══', 'cyan');
  const script = join(ROOT, 'scripts/training-cycle.js');
  const ok = runScript(script, ['--week'], 30);
  log(ok ? '✅' : '⚠️', ok ? 'Training cycle concluído' : 'Training cycle parcial', ok ? 'green' : 'yellow');
  return ok;
}

// ── Fase 4: Protocolo Sniper ─────────────────────────────────────────────────
async function fase4_sniperProtocol() {
  console.log('\n' + chalk.bold.red('█'.repeat(64)));
  console.log(chalk.bold.red('  🎯  FASE 4 — PROTOCOLO SNIPER MILITAR'));
  console.log(chalk.bold.red('  "One Shot, One Kill" — Precisão acima de Quantidade'));
  console.log(chalk.bold.red('█'.repeat(64)));

  const script = join(ROOT, 'scripts/sniper-protocol.js');
  const ok = runScript(script, [], 20);

  if (ok) {
    // Lê thresholds recém-calculados para exibir resumo no relatório
    try {
      const pie = JSON.parse(readFileSync(join(ROOT, 'data/pie.json'), 'utf8'));
      const thr = pie.sniper_thresholds?.thresholds || {};
      log('🎯', 'Thresholds sniper atualizados:', 'cyan');
      for (const [market, data] of Object.entries(thr)) {
        const accStr  = data.achievedAcc != null ? `${data.achievedAcc}%` : '---';
        const gapStr  = data.gap != null ? (data.gap <= 0 ? chalk.green('META') : chalk.yellow(`-${data.gap}pp`)) : '---';
        const bandCol = data.band === 'ELITE' ? 'cyan' : data.band === 'HOT' ? 'green' : 'yellow';
        log('  🔫', `${market.padEnd(22)} banda: ${chalk[bandCol](data.band.padEnd(5))}  precisão: ${accStr}  ${gapStr}`, 'white');
      }
    } catch { /* non-critical */ }
  } else {
    log('⚠️', 'Protocolo Sniper parcial — thresholds anteriores mantidos', 'yellow');
  }

  return ok;
}

// ── Relatório de progresso ────────────────────────────────────────────────────
function relatorio() {
  console.log('\n' + '═'.repeat(64));
  log('📋', '═══ DEBRIEFING FINAL — STATUS POR MERCADO ═══', 'cyan');
  console.log('═'.repeat(64));

  const accuracy = readCurrentAccuracy();

  // Lê thresholds sniper para combinar no relatório
  let sniperThr = {};
  try {
    const pie = JSON.parse(readFileSync(join(ROOT, 'data/pie.json'), 'utf8'));
    sniperThr = pie.sniper_thresholds?.thresholds || {};
  } catch { /* sem sniper data */ }

  let prontos = 0, emProgressão = 0, longe = 0;

  for (const [market, data] of Object.entries(accuracy)) {
    const { acc, target, gap, samples } = data;
    const status = gap <= 0 ? '✅ META ATINGIDA' : gap <= 5 ? '🟡 Próximo' : gap <= 15 ? '🟠 Em progresso' : '🔴 Distante';
    const color  = gap <= 0 ? 'green' : gap <= 5 ? 'yellow' : gap <= 15 ? 'yellow' : 'red';

    // Complemento sniper
    const st       = sniperThr[market];
    const sniperStr = st
      ? `  [sniper: ${st.band} ≥${st.minSignals}s → ${st.achievedAcc ?? '--'}%]`
      : '';

    log('  ', `${market.padEnd(22)} ${String(acc).padStart(3)}% → meta ${target}%  [gap: ${gap > 0 ? '+' : ''}${gap}pp]  ${status}  (${samples} amostras)${sniperStr}`, color);

    if (gap <= 0) prontos++;
    else if (gap <= 10) emProgressão++;
    else longe++;
  }

  const total = prontos + emProgressão + longe;

  console.log('\n' + '─'.repeat(64));
  log('📊', `Mercados na meta: ${prontos}/${total}  |  Próximos: ${emProgressão}  |  Distantes: ${longe}`, 'cyan');

  // Avaliação de performance sniper
  const sniperMarkets  = Object.values(sniperThr).filter(t => t.achievedAcc != null);
  const sniperOnTarget = sniperMarkets.filter(t => t.gap != null && t.gap <= 0).length;
  if (sniperMarkets.length) {
    log('🎯', `Precisão sniper na meta: ${sniperOnTarget}/${sniperMarkets.length} mercados`, sniperOnTarget === sniperMarkets.length ? 'green' : 'yellow');
  }

  console.log('═'.repeat(64) + '\n');
  logProgress({ fase: 'relatorio', accuracy, sniperThr, resumo: { prontos, emProgressão, longe } });

  // Sincroniza com Obsidian — "Cérebro vivo" do projeto
  if (isObsidianConfigured()) {
    try {
      const duracao = Math.round((Date.now() - (_sessionStart || Date.now())) / 60000);
      const r1 = updateTreinamentoNoturno({
        accuracy,
        sniperThr,
        resumo: { prontos, emProgressão, longe },
        duracao,
      });
      const r2 = rebuildDashboard();
      log('📓', `Obsidian sincronizado → 🌙 Treinamento Noturno.md${r2 ? ' + Dashboard' : ''}`, r1 ? 'green' : 'yellow');
    } catch (e) {
      log('⚠️', `Obsidian sync falhou: ${e.message}`, 'yellow');
    }
  }
}

// ── Sequência de treinamento noturno ─────────────────────────────────────────
let treinando    = false;
let _sessionStart = null; // timestamp de início para cálculo de duração no relatorio()

async function treinamentoNoturno() {
  if (treinando) {
    log('⏭️', 'Treinamento já em andamento — ignorando disparo duplicado', 'yellow');
    return;
  }
  treinando = true;
  _sessionStart = Date.now();

  console.log('\n' + '═'.repeat(64));
  log('🌙', 'INÍCIO DO TREINAMENTO NOTURNO', 'cyan');
  console.log('═'.repeat(64) + '\n');

  const inicio = Date.now();

  await fase1_expandirHistorico();
  await fase2_deepTraining();
  await fase3_trainingCycle();
  await fase4_sniperProtocol();
  relatorio();

  const minutos = Math.round((Date.now() - inicio) / 60000);
  log('🏁', `Treinamento noturno concluído em ${minutos} min`, 'green');
  console.log('═'.repeat(64) + '\n');
  treinando = false;
}

// ── Agendamento ───────────────────────────────────────────────────────────────
console.log(chalk.bold.cyan('\n' + '═'.repeat(64)));
console.log(chalk.bold.cyan('  🌙 Overnight Trainer — Protocolo Sniper Ativo'));
console.log(chalk.bold.cyan('═'.repeat(64)));
console.log('  02:00 → Expansão histórica (+7 dias SofaScore)');
console.log('  03:00 → Deep Training 9 fases (padrões + calibração)');
console.log('  04:00 → Training Cycle semanal');
console.log(chalk.bold.red('  04:30 → 🎯 PROTOCOLO SNIPER — Precisão por banda de confiança'));
console.log('  05:00 → Debriefing + thresholds salvos no PIE');
console.log(chalk.bold.yellow('\n  Filosofia: "One Shot, One Kill" — Zero disparos sem confirmação'));
console.log('  Meta:  98% Over 1.5 | 95% BTTS | 92% Over 2.5\n');

// Fase 1 — 02:00 coleta histórico
cron.schedule('0 2 * * *', async () => {
  if (treinando) return;
  treinando = true;
  log('📥', '02:00 — Expansão histórica iniciada', 'cyan');
  await fase1_expandirHistorico();
  treinando = false;
}, { timezone: 'America/Sao_Paulo' });

// Fase 2 — 03:00 deep training (após coleta terminar)
cron.schedule('0 3 * * *', async () => {
  if (treinando) return;
  treinando = true;
  log('🧠', '03:00 — Deep Training iniciado', 'cyan');
  await fase2_deepTraining();
  treinando = false;
}, { timezone: 'America/Sao_Paulo' });

// Fase 3 — 04:00 training cycle
cron.schedule('0 4 * * *', async () => {
  if (treinando) return;
  treinando = true;
  log('🔄', '04:00 — Training Cycle iniciado', 'cyan');
  await fase3_trainingCycle();
  treinando = false;
}, { timezone: 'America/Sao_Paulo' });

// Fase 4 — 04:30 Protocolo Sniper (após training cycle estabilizar)
cron.schedule('30 4 * * *', async () => {
  if (treinando) return;
  treinando = true;
  log('🎯', '04:30 — PROTOCOLO SNIPER iniciado', 'red');
  await fase4_sniperProtocol();
  relatorio();
  treinando = false;
}, { timezone: 'America/Sao_Paulo' });

// Aguarda o primeiro disparo agendado (02:00 BRT).
// Não roda imediatamente para evitar criar processos filhos logo após boot/restart
// e para evitar loop de crash: se scripts de treinamento falharem, o processo
// terminaria em <120s e PM2 tentaria reiniciar indefinidamente.
log('⏳', 'Aguardando agendamento das 02:00 para iniciar treinamento...', 'gray');
log('⚙️',  'Crons ativos: 02:00 histórico | 03:00 deep | 04:00 cycle | 04:30 sniper', 'gray');
