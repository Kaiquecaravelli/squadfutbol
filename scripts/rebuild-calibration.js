/**
 * rebuild-calibration.js — Reconstrói a calibração PIE do zero com dados REAIS
 *
 * Problema: a calibração atual está contaminada com dados injetados sinteticamente
 * que mostram 100% de acurácia (impossível). Isso mascara a performance real do modelo.
 *
 * O que este script faz:
 *  1. Limpa toda a calibração sintética do pie.json
 *  2. Reconstrói a calibração SOMENTE a partir dos 90 resultados verificados reais
 *  3. Exibe o relatório honesto antes/depois
 *
 * Uso:
 *   node scripts/rebuild-calibration.js           → executa a limpeza
 *   node scripts/rebuild-calibration.js --dry-run → mostra o que faria sem salvar
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH  = join(__dir, '../data/pie.json');
const DRY_RUN  = process.argv.includes('--dry-run');

// ── Funções auxiliares ────────────────────────────────────────────────────────
function loadDB()    { return JSON.parse(readFileSync(DB_PATH, 'utf8')); }
function saveDB(db)  { writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }
function backupDB()  {
  const bak = DB_PATH.replace('.json', `.bak-${Date.now()}.json`);
  copyFileSync(DB_PATH, bak);
  return bak;
}

function probRange(p) {
  const n = Number(p) || 0;
  if (n < 50)  return '<50';
  if (n < 60)  return '50-60';
  if (n < 70)  return '60-70';
  if (n < 80)  return '70-80';
  if (n < 85)  return '80-85';
  if (n < 90)  return '85-90';
  return '90+';
}

function updateCalib(calibration, market, prob, acertou, competition) {
  if (!calibration[market]) {
    calibration[market] = { total: 0, hits: 0, byRange: {}, byCompetition: {} };
  }
  const c   = calibration[market];
  const hit = acertou === true ? 1 : 0;
  const rng = probRange(prob);

  c.total++;
  c.hits += hit;

  if (!c.byRange[rng]) c.byRange[rng] = { total: 0, hits: 0 };
  c.byRange[rng].total++;
  c.byRange[rng].hits += hit;

  if (competition) {
    const comp = String(competition).slice(0, 40);
    if (!c.byCompetition[comp]) c.byCompetition[comp] = { total: 0, hits: 0 };
    c.byCompetition[comp].total++;
    c.byCompetition[comp].hits += hit;
  }
}

// ── Relatório de calibração ───────────────────────────────────────────────────
function printCalibReport(calibration, label) {
  console.log(chalk.bold(`\n${label}`));
  console.log('  ' + 'Mercado'.padEnd(26) + 'Amostras'.padStart(9) + '  Acurácia');
  console.log('  ' + '─'.repeat(50));
  for (const [mkt, c] of Object.entries(calibration).sort((a, b) => b[1].total - a[1].total)) {
    if (c.total === 0) continue;
    const acc    = (c.hits / c.total * 100).toFixed(1);
    const status = parseFloat(acc) >= 70 ? chalk.green('✅') :
                   parseFloat(acc) >= 55 ? chalk.yellow('⚠️') : chalk.red('❌');
    const note   = c.total < 30 ? chalk.gray(' (poucas amostras)') : '';
    console.log(`  ${status} ${mkt.padEnd(24)} ${String(c.total).padStart(6)}    ${acc}%${note}`);
  }
}

// ── Pipeline principal ────────────────────────────────────────────────────────
async function run() {
  console.log('\n' + '═'.repeat(64));
  console.log('  🔧 Rebuild Calibração PIE — Limpeza de Dados Sintéticos');
  console.log(`  Modo: ${DRY_RUN ? 'DRY-RUN (sem salvar)' : 'REAL'}`);
  console.log('═'.repeat(64) + '\n');

  const db = loadDB();

  // ── Relatório ANTES ───────────────────────────────────────────────────────
  printCalibReport(db.calibration || {}, '📊 CALIBRAÇÃO ATUAL (contaminada):');

  // ── Identifica dados sintéticos ───────────────────────────────────────────
  console.log(chalk.yellow('\n⚠️  Identificando dados sintéticos...'));
  let syntheticCount = 0;
  for (const [mkt, c] of Object.entries(db.calibration || {})) {
    if (c.total < 30) continue;
    // Indicador de dado sintético: 100% em ligas inteiras (impossível na realidade)
    const synthetic100 = Object.entries(c.byCompetition || {})
      .filter(([, v]) => v.total >= 10 && v.hits === v.total);
    if (synthetic100.length > 0) {
      const leagues = synthetic100.map(([k]) => k).join(', ');
      console.log(chalk.red(`  ❌ ${mkt}: 100% em ${synthetic100.length} liga(s) — sintético: ${leagues}`));
      syntheticCount++;
    }
  }
  if (syntheticCount === 0) {
    console.log(chalk.green('  ✅ Nenhum padrão sintético óbvio detectado'));
  }

  // ── Reconstrói calibração do zero a partir dos resultados reais ───────────
  console.log(chalk.cyan('\n🔄 Reconstruindo calibração a partir dos resultados reais...'));

  const newCalibration = {};
  const results = db.results || [];
  const predictions = db.predictions || [];

  let processed = 0;
  for (const result of results) {
    const pred = predictions.find(p => p.id === result.prediction_id);
    const competition = pred?.competition || '';

    for (const outcome of result.market_outcomes || []) {
      if (outcome.acertou === null || outcome.acertou === undefined) continue;
      updateCalib(newCalibration, outcome.market, outcome.probabilidade || 75, outcome.acertou, competition);
      processed++;
    }
  }

  console.log(chalk.green(`  ✅ ${processed} outcomes processados de ${results.length} resultados reais`));

  // ── Relatório DEPOIS ──────────────────────────────────────────────────────
  printCalibReport(newCalibration, '📊 CALIBRAÇÃO RECONSTRUÍDA (apenas dados reais):');

  // ── Estatísticas globais recalculadas ──────────────────────────────────────
  let totalHits = 0, totalErros = 0;
  for (const c of Object.values(newCalibration)) {
    totalHits  += c.hits;
    totalErros += c.total - c.hits;
  }
  const globalAcc = totalHits + totalErros > 0
    ? (totalHits / (totalHits + totalErros) * 100).toFixed(1)
    : 'N/A';

  console.log(chalk.bold(`\n📈 Taxa global real: ${globalAcc}%  (${totalHits}/${totalHits + totalErros})`));

  if (DRY_RUN) {
    console.log(chalk.yellow('\n[DRY-RUN] Nenhuma alteração salva.'));
    return;
  }

  // ── Backup e salva ─────────────────────────────────────────────────────────
  const bakPath = backupDB();
  console.log(chalk.gray(`\n💾 Backup criado: ${bakPath.split('\\').pop()}`));

  db.calibration = newCalibration;
  db.stats.acertos = totalHits;
  db.stats.erros   = totalErros;

  // Mantém lições — elas não são dados de calibração, são regras aprendidas
  saveDB(db);
  console.log(chalk.green.bold('\n✅ Calibração reconstruída e salva com sucesso!'));
  console.log(chalk.gray('   Execute agora: npm run historical-backfill'));
  console.log(chalk.gray('   para adicionar dados históricos reais do SofaScore.\n'));
}

run().catch(e => {
  console.error(chalk.red(`\nERRO: ${e.message}`));
  process.exit(1);
});
