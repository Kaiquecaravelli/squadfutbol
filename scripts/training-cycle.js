/**
 * training-cycle.js — Ciclo de Treinamento do Sistema
 *
 * Executa um ciclo de treinamento: valida progresso atual vs metas do PIE,
 * roda deep-training se há déficit de acurácia e gera relatório de evolução.
 *
 * Modos:
 *   node scripts/training-cycle.js          → ciclo padrão
 *   node scripts/training-cycle.js --week   → ciclo semanal (últimos 7 dias)
 *   node scripts/training-cycle.js --report → somente relatório (sem treino)
 *   npm run train                           → alias para ciclo padrão
 *   npm run train-week                      → alias --week
 *   npm run train-report                    → alias --report
 */

import 'dotenv/config';
import chalk        from 'chalk';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR  = join(ROOT, 'logs');
const PIE_PATH = join(ROOT, 'data', 'pie.json');

mkdirSync(LOG_DIR, { recursive: true });

const IS_WEEK   = process.argv.includes('--week');
const IS_REPORT = process.argv.includes('--report');

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

function ts() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function log(icon, msg, color = 'white') {
  const line = `[${ts()}] ${icon}  ${msg}`;
  console.log(chalk[color]?.(line) ?? line);
}

function readAccuracy() {
  try {
    const pie = JSON.parse(readFileSync(PIE_PATH, 'utf8'));
    const cal = pie.calibration || {};
    const result = {};
    for (const [market, target] of Object.entries(TARGETS)) {
      const c = cal[market];
      if (c && c.total >= 10) {
        const acc = Math.round((c.hits / c.total) * 100);
        result[market] = { acc, target, gap: target - acc, samples: c.total };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function runScript(script, args = [], timeoutMin = 30) {
  const cmd = `node "${join(ROOT, 'scripts', script)}" ${args.join(' ')}`;
  log('⚙️', `Executando: ${script} ${args.join(' ')}`, 'cyan');
  try {
    execSync(cmd, { cwd: ROOT, timeout: timeoutMin * 60_000, windowsHide: true, stdio: 'inherit' });
    return true;
  } catch (e) {
    log('⚠️', `${script} falhou: ${e.message?.split('\n')[0]}`, 'yellow');
    return false;
  }
}

async function runTrainingCycle() {
  console.log('\n' + '═'.repeat(60));
  log('🔄', `TRAINING CYCLE — ${IS_WEEK ? 'SEMANAL' : 'PADRÃO'}`, 'cyan');
  console.log('═'.repeat(60));

  const before = readAccuracy();

  // Relatório do estado atual
  log('📊', 'Estado atual por mercado:', 'cyan');
  let prontos = 0, distantes = 0;
  for (const [market, data] of Object.entries(before)) {
    const { acc, target, gap, samples } = data;
    const status = gap <= 0 ? '✅ META' : gap <= 10 ? '🟡 Próximo' : '🔴 Distante';
    const color  = gap <= 0 ? 'green' : gap <= 10 ? 'yellow' : 'red';
    log('  ', `${market.padEnd(22)} ${String(acc).padStart(3)}% → meta ${target}% [gap ${gap > 0 ? '+' : ''}${gap}pp] (${samples}s) ${status}`, color);
    if (gap <= 0) prontos++; else distantes++;
  }

  if (IS_REPORT) {
    log('📋', `Relatório — ${prontos} na meta · ${distantes} distantes`, 'cyan');
    console.log('═'.repeat(60) + '\n');
    return;
  }

  if (distantes === 0) {
    log('✅', 'Todos os mercados na meta — treinamento não necessário', 'green');
    console.log('═'.repeat(60) + '\n');
    return;
  }

  log('🧠', `${distantes} mercado(s) abaixo da meta — iniciando deep training...`, 'yellow');

  const daysArg = IS_WEEK ? '--days=7' : '--days=3';

  // Passo 1: backfill para fechar loops de feedback antes de treinar
  runScript('result-backfill.js', [daysArg], 20);

  // Passo 2: deep training com regras resetadas
  runScript('deep-training.js', ['--reset-rules'], 45);

  // Passo 3: sniper protocol para recalibrar thresholds
  runScript('sniper-protocol.js', [], 15);

  // Relatório final
  const after = readAccuracy();
  console.log('\n' + '─'.repeat(60));
  log('📈', 'Variação pós-treino:', 'green');
  for (const [market, aft] of Object.entries(after)) {
    const bef   = before[market];
    const delta = bef ? aft.acc - bef.acc : 0;
    const arrow = delta > 0 ? `+${delta}pp ↑` : delta < 0 ? `${delta}pp ↓` : '—';
    const color = delta > 0 ? 'green' : delta < 0 ? 'red' : 'gray';
    log('  ', `${market.padEnd(22)} ${String(aft.acc).padStart(3)}% → meta ${aft.target}% ${arrow}`, color);
  }

  try {
    writeFileSync(join(LOG_DIR, 'training-progress.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), modo: IS_WEEK ? 'week' : 'padrao', before, after }) + '\n',
      { flag: 'a' });
  } catch { /* non-critical */ }

  console.log('═'.repeat(60) + '\n');
}

runTrainingCycle().catch(e => {
  console.error(chalk.red(`\n❌ ERRO: ${e.message}`));
  process.exit(1);
});
