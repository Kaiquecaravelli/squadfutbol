/**
 * daily-pipeline.js — Pipeline Diário de Coleta, Análise e Aprendizado
 *
 * Regra: executa após 24h de cada rodada, garantindo que todos os resultados
 * já estejam disponíveis no SofaScore antes de fechar o loop de feedback.
 *
 * Fluxo:
 *   1. COLETA     → SofaScore: ontem + anteontem (garante resultados finais)
 *   2. BACKFILL   → Fecha loop: predições pendentes → resultado real → PIE
 *   3. INJEÇÃO    → Padrões das partidas coletadas → PIE (calibração)
 *   4. VALIDAÇÃO  → Filtra oportunidades com critérios mínimos de qualidade
 *   5. TELEGRAM   → Envia apenas o que passou nos gates (sem spam)
 *   6. RELATÓRIO  → Resumo do estado do PIE no canal
 *
 * Critérios de Gate (para envio ao Telegram):
 *   - Precisão PIE do mercado >= 70%  (calibrado com >= 30 amostras)
 *   - EV (Expected Value) >= 8%
 *   - Odds dentro do sweet spot do mercado
 *   - Confiança do modelo >= 75
 *
 * Uso:
 *   node scripts/daily-pipeline.js             → executa pipeline completo
 *   node scripts/daily-pipeline.js --dry-run   → sem Telegram nem persistência
 *   node scripts/daily-pipeline.js --report    → só relatório PIE no Telegram
 *   node scripts/daily-pipeline.js --dates=3   → coleta N dias para trás
 *
 * Agendamento (crontab ou Task Scheduler):
 *   0 8 * * *  → Executa todo dia às 08h (após partidas da madrugada fecharem)
 */

import { execFile }           from 'child_process';
import { promisify }          from 'util';
const execFileAsync = promisify(execFile);
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname }      from 'path';
import { fileURLToPath }      from 'url';
import chalk                  from 'chalk';
import {
  loadDB,
  getPendingPredictions,
  saveResult,
  getStats,
  savePieSnapshot,
}                             from '../src/pie/pie-storage.js';
import {
  notifyPIEStats,
  notifyPreLiveAnalysis,
}                             from '../src/utils/telegram.js';
import axios                  from 'axios';
import {
  startRun,
  checkpoint,
  completeRun,
  readState,
}                             from '../src/resilience/state-manager.js';
import { watchdog, withRetry } from '../src/resilience/network-watchdog.js';
import { logRecoveryStatus, isRecoverable } from '../src/resilience/recovery.js';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');

// ── Configuração ───────────────────────────────────────────────────────────────
const SOFA_BASE = 'https://api.sofascore.com/api/v1';
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};

// Gates de qualidade para envio ao Telegram
const GATE = {
  PIE_MIN_SAMPLES:   30,    // mínimo de amostras no PIE para confiar na calibração
  PIE_MIN_ACCURACY:  70,    // mínimo de precisão histórica (%)
  MIN_EV_PCT:         8,    // EV mínimo (%)
  MIN_CONFIDENCE:    75,    // confiança mínima do modelo
  MIN_ODDS:          1.50,  // odds mínima válida (mercados abaixo de 1.50 têm margem insuficiente)
  MAX_ODDS:         100,    // ceiling pré-live (inclui mercados longos como placar exato)
};

// Sweet spots de odds por mercado (baseado em calibração real do PIE)
const ODDS_SWEET_SPOT = {
  'Over 1.5':          { min: 1.50, max: 2.00 },  // mín alinhado ao novo gate
  'Over 2.5':          { min: 1.55, max: 2.00 },
  'Over 3.5':          { min: 2.00, max: 3.80 },
  'BTTS':              { min: 1.60, max: 2.10 },
  'Over Corners 6.5':  { min: 1.50, max: 1.75 },  // mín alinhado
  'Over Corners 7.5':  { min: 1.60, max: 2.10 },
  'Over Corners 8.5':  { min: 1.75, max: 2.40 },
  'YC 2.5':            { min: 1.55, max: 2.00 },
  'YC 3.5':            { min: 1.90, max: 2.90 },
  '1X':                { min: 1.50, max: 2.00 },  // era 1.08-1.40 — mercado pequeno demain
  'X2':                { min: 1.50, max: 2.20 },  // era 1.15-1.55
  'Home Win':          { min: 1.50, max: 3.00 },  // mín alinhado
  'Away Win':          { min: 1.50, max: 3.00 },
};

// Precisão mínima por mercado — mercados com histórico baixo exigem mais evidência
// (só bloqueia se houver >= PIE_MIN_SAMPLES; abaixo disso, usa o gate global)
const PIE_ACCURACY_BY_MARKET = {
  'Over 3.5':         80,  // histórico: 40% — exige calibração muito mais sólida
  'Over Corners 8.5': 80,  // histórico: 62% — mercado difícil, threshold alto
  'YC 3.5':           80,  // histórico: 54% — cartões são imprevisíveis
  'X2':               80,  // histórico: 53% — dupla chance visitante requer mais dados
  'Over Corners 7.5': 75,  // histórico: 69% — ligeiramente acima do global
};

// ── Utilidades ─────────────────────────────────────────────────────────────────
function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(icon, msg, color = 'white') {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(chalk[color](`[${ts}] ${icon} ${msg}`));
}

// ── Gate de Qualidade ──────────────────────────────────────────────────────────
function passesGate(opportunity, db) {
  const { market, confianca, odds_minima, ev_estimado } = opportunity;

  // 1. Confiança mínima
  if ((confianca || 0) < GATE.MIN_CONFIDENCE) return { ok: false, reason: `confiança ${confianca} < ${GATE.MIN_CONFIDENCE}` };

  // 2. Odds dentro do range válido
  const odds = parseFloat(odds_minima) || 0;
  if (odds < GATE.MIN_ODDS || odds > GATE.MAX_ODDS) return { ok: false, reason: `odds ${odds} fora do range` };

  // 3. Sweet spot por mercado
  const sweet = ODDS_SWEET_SPOT[market];
  if (sweet && (odds < sweet.min || odds > sweet.max)) {
    return { ok: false, reason: `odds ${odds} fora do sweet spot (${sweet.min}-${sweet.max})` };
  }

  // 4. EV mínimo
  const ev = parseFloat(ev_estimado) || 0;
  if (ev < GATE.MIN_EV_PCT) return { ok: false, reason: `EV ${ev}% < ${GATE.MIN_EV_PCT}%` };

  // 5. PIE — calibração do mercado (com threshold específico por mercado se definido)
  const cal = db.calibration?.[market];
  if (cal && cal.total >= GATE.PIE_MIN_SAMPLES) {
    const accuracy     = (cal.hits / cal.total) * 100;
    const minAccuracy  = PIE_ACCURACY_BY_MARKET[market] ?? GATE.PIE_MIN_ACCURACY;
    if (accuracy < minAccuracy) {
      return { ok: false, reason: `PIE ${accuracy.toFixed(0)}% < ${minAccuracy}% (threshold ${market})` };
    }
  }

  return { ok: true };
}

// ── ETAPA 1: Coleta SofaScore ─────────────────────────────────────────────────
async function etapa1_coletar(dates, dryRun) {
  log('📡', 'ETAPA 1 — Coleta SofaScore', 'bold');

  // Filtra datas que precisam ser coletadas
  const pending = dates.filter(date => !existsSync(join(ROOT, 'data/daily-matches', `${date}.json`)));
  const already = dates.filter(date =>  existsSync(join(ROOT, 'data/daily-matches', `${date}.json`)));
  already.forEach(d => log('  ✅', `${d} — já coletado, ignorando`, 'gray'));

  if (!pending.length) {
    log('📡', 'Coleta concluída: todas as datas já existem', 'green');
    return 0;
  }

  // Paralleliza coleta de todas as datas pendentes simultaneamente
  log('  🔄', `Coletando em paralelo: ${pending.join(', ')}`, 'cyan');
  let totalColetadas = 0;

  const collectResults = await Promise.allSettled(
    pending.map(date =>
      dryRun
        ? Promise.resolve({ date, ok: true })
        : execFileAsync('node', ['scripts/sofascore-collector.js', date], {
            cwd: ROOT, timeout: 90_000,
          }).then(() => ({ date, ok: true })).catch(e => ({ date, ok: false, err: e }))
    )
  );

  for (const r of collectResults) {
    const { date, ok, err } = r.status === 'fulfilled' ? r.value : { date: '?', ok: false, err: r.reason };
    if (ok) { log('  ✅', `${date} — coletado`, 'green'); totalColetadas++; }
    else    { log('  ❌', `${date} — falhou: ${(err?.message || '').split('\n')[0]}`, 'red'); }
  }

  log('📡', `Coleta concluída: ${totalColetadas} novas datas`, 'green');
  return totalColetadas;
}

// ── ETAPA 2: Backfill — fechar loop de feedback ───────────────────────────────
async function etapa2_backfill(dryRun) {
  log('🔄', 'ETAPA 2 — Backfill de Resultados', 'bold');

  const pending = getPendingPredictions();

  // Só processa predições com >= 24h (resultados garantidos)
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const ready     = pending.filter(p => {
    const created = new Date(p.created_at || 0).getTime();
    return created <= cutoff24h;
  });

  if (!ready.length) {
    log('  ℹ️', `Nenhuma predição pendente com >= 24h`, 'gray');
    return 0;
  }

  log('  📋', `${ready.length} predições aguardando resultado`, 'cyan');

  let fechadas = 0, erros = 0;

  // FIX: paraleliza em lotes de 5 (era serial com sleep(1000) entre cada — 50 predições = ~1min)
  // Lotes evitam flood na API SofaScore enquanto reduzem tempo em ~80%
  const BATCH_SIZE = 5;

  async function _fetchOnePred(pred) {
    let result = null;
    if (pred.sofascore_id) {
      result = await withRetry(() => fetchResult(pred.sofascore_id), { label: `SofaScore result ${pred.sofascore_id}` }).catch(() => null);
    }
    if (!result) {
      result = await withRetry(() => trySearchByName(pred.match_name, pred.match_date), { label: `SofaScore search ${pred.match_name}` }).catch(() => null);
    }
    return { pred, result };
  }

  for (let i = 0; i < ready.length; i += BATCH_SIZE) {
    const batch   = ready.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(_fetchOnePred));

    for (const settled of results) {
      if (settled.status === 'rejected') { erros++; continue; }
      const { pred, result } = settled.value;
      const label = (pred.match_name || pred.match_id || '').substring(0, 45);

      if (!result || result.status !== 'finished' || !result.score) { erros++; continue; }

      const { score, stats } = result;
      const marketOutcomes = pred.markets.map(m => ({
        market:         m.market,
        recommendation: m.recommendation,
        probabilidade:  m.probabilidade,
        acertou:        resolveMarket(m.market, m.recommendation, score, stats),
      }));

      const verificaveis = marketOutcomes.filter(o => o.acertou !== null);
      const acertos      = verificaveis.filter(o => o.acertou).length;

      if (!dryRun) {
        try {
          saveResult({
            predictionId:   pred.id,
            matchName:      pred.match_name,
            placarReal:     `${score.home}-${score.away}`,
            marketOutcomes,
          });
          fechadas++;
        } catch { erros++; }
      } else {
        fechadas++;
      }

      log(
        '  ✅',
        `${label} → ${score.home}-${score.away} | ${acertos}/${verificaveis.length} ✅`,
        acertos === verificaveis.length ? 'green' : 'yellow'
      );
    }

    // Pausa apenas entre lotes (não entre cada predição individual)
    if (i + BATCH_SIZE < ready.length) await sleep(1200);
  }

  log('🔄', `Backfill: ${fechadas} fechadas, ${erros} sem resultado ainda`, 'green');
  return fechadas;
}

// ── ETAPA 3: Injeção PIE ──────────────────────────────────────────────────────
async function etapa3_injetar(dates, dryRun) {
  log('🧠', 'ETAPA 3 — Injeção de Padrões no PIE', 'bold');

  const injectDates = dates.filter(d => existsSync(join(ROOT, 'data/daily-matches', `${d}.json`)));
  dates.filter(d => !existsSync(join(ROOT, 'data/daily-matches', `${d}.json`)))
       .forEach(d => log('  ⏭', `${d} — sem arquivo, pulando`, 'gray'));

  if (!injectDates.length) {
    log('🧠', 'Injeção concluída: nenhum arquivo disponível', 'gray');
    return 0;
  }

  // Paralleliza injeção PIE de todas as datas simultaneamente
  log('  🔄', `Injetando em paralelo: ${injectDates.join(', ')}`, 'cyan');
  let totalInjetados = 0;

  const injectResults = await Promise.allSettled(
    injectDates.map(date =>
      dryRun
        ? Promise.resolve({ date, count: 1 })
        : execFileAsync('node', ['scripts/daily-pie-update.js', date], {
            cwd: ROOT, timeout: 120_000,
          }).then(({ stdout }) => {
            const m = (stdout || '').match(/(\d+) jogos processados/);
            return { date, count: m ? parseInt(m[1]) : 0 };
          }).catch(e => ({ date, count: 0, err: e }))
    )
  );

  for (const r of injectResults) {
    const { date, count, err } = r.status === 'fulfilled' ? r.value : { date: '?', count: 0, err: r.reason };
    if (!err) { log('  ✅', `${date} — ${count} jogos injetados`, 'green'); totalInjetados += count; }
    else      { log('  ❌', `${date} — falhou: ${(err?.message || '').split('\n')[0]}`, 'red'); }
  }

  log('🧠', `Injeção concluída: ~${totalInjetados} partidas adicionadas`, 'green');
  return totalInjetados;
}

// ── ETAPA 4: Validação e Gate de Qualidade ────────────────────────────────────
async function etapa4_validar() {
  log('🎯', 'ETAPA 4 — Validação e Gate de Qualidade', 'bold');

  const db     = loadDB();
  const preds  = db.predictions || [];

  // Analisa predições recentes (últimas 48h) que ainda não foram ao ar como análise
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = preds.filter(p => {
    const created = new Date(p.created_at || 0).getTime();
    return created >= cutoff && !p.result_id; // sem resultado = ainda vai acontecer
  });

  log('  📋', `${recent.length} predições recentes (últimas 48h sem resultado)`, 'cyan');

  const qualified = [];

  for (const pred of recent) {
    for (const m of (pred.markets || [])) {
      // Monta objeto no formato esperado pelo gate
      const opp = {
        market:       m.market,
        confianca:    m.confianca || 0,
        odds_minima:  m.odds_minima || 0,
        ev_estimado:  m.ev_estimado || 0,
        probabilidade: m.probabilidade || 0,
        recomendacao: m.recommendation || '',
      };

      const gate = passesGate(opp, db);

      if (gate.ok) {
        qualified.push({
          pred,
          market: opp,
          gate,
          cal: db.calibration?.[m.market],
        });
        log(
          '  ✅',
          `${pred.match_name?.substring(0,35)} → ${m.market} @ ${m.odds_minima} | EV:${m.ev_estimado}% | Conf:${m.confianca}`,
          'green'
        );
      } else {
        log('  ⏭', `${pred.match_name?.substring(0,30)} ${m.market} — rejeitado: ${gate.reason}`, 'gray');
      }
    }
  }

  log('🎯', `Gate: ${qualified.length}/${recent.reduce((s,p) => s + (p.markets||[]).length, 0)} oportunidades passaram`, 'green');
  return qualified;
}

// ── Helpers de deduplicação cross-pipeline ────────────────────────────────────
const NOTIFIED_KEYS_PATH = join(ROOT, 'data/notified-keys.json');
const DEDUP_WINDOW_PIPELINE_MS = 24 * 60 * 60 * 1000; // 24h

function _loadNotifiedKeys() {
  try { return JSON.parse(readFileSync(NOTIFIED_KEYS_PATH, 'utf-8')); }
  catch { return {}; }
}

function _saveNotifiedKey(key) {
  const db = _loadNotifiedKeys();
  // Limpa chaves com mais de 2 dias antes de salvar
  const cutoff = Date.now() - 2 * 86_400_000;
  for (const k of Object.keys(db)) { if (db[k] < cutoff) delete db[k]; }
  db[key] = Date.now();
  try { writeFileSync(NOTIFIED_KEYS_PATH, JSON.stringify(db), 'utf-8'); } catch {}
}

function _isAlreadyNotified(key) {
  const db = _loadNotifiedKeys();
  const ts = db[key];
  return ts && (Date.now() - ts) < DEDUP_WINDOW_PIPELINE_MS;
}

// ── ETAPA 4.5: URL Gate — descarta oportunidades sem URL direta no Superbet ───
async function etapa4b_urlGate(qualified) {
  log('🔗', 'ETAPA 4.5 — URL Gate Superbet', 'bold');

  if (!qualified.length) return [];

  const { ensureFresh, lookupMatchUrl } = await import('../src/scrapers/superbet-cache.js');

  log('  🌐', 'Atualizando cache de URLs Superbet (PRÉ-LIVE)...', 'cyan');
  await ensureFresh('prelive');

  const gated = [];

  for (const item of qualified) {
    const matchName = item.pred.match_name || '';
    // Extrai home e away do "Home vs Away"
    const parts = matchName.split(/\s+vs\s+/i);
    const home  = parts[0]?.trim() || '';
    const away  = parts[1]?.trim() || '';

    if (!home || !away) {
      log('  ⚠️', `${matchName} — nome inválido, bloqueado`, 'yellow');
      continue;
    }

    const url = lookupMatchUrl(home, away, 'prelive');

    if (!url) {
      log('  🚫', `${matchName.substring(0, 40)} — sem URL Superbet, análise bloqueada`, 'red');
      continue;
    }

    // Valida se a URL ainda está acessível (evita link morto no Telegram)
    let urlOk = false;
    try {
      const probe = await axios.head(url, {
        timeout: 6000,
        maxRedirects: 3,
        validateStatus: s => s < 500,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      urlOk = probe.status < 400;
    } catch {
      urlOk = false;
    }

    if (!urlOk) {
      log('  🔴', `${matchName.substring(0, 40)} — link Superbet inativo (${url.slice(0, 50)}...), bloqueado`, 'red');
      continue;
    }

    item.superbetUrl = url;
    gated.push(item);
    log('  ✅', `${matchName.substring(0, 40)} — URL validada e ativa`, 'green');
  }

  log(
    '🔗',
    `URL Gate: ${gated.length}/${qualified.length} com link confirmado ${gated.length < qualified.length ? `(${qualified.length - gated.length} bloqueadas)` : ''}`,
    gated.length > 0 ? 'green' : 'yellow'
  );

  return gated;
}

// ── ETAPA 5: Telegram ─────────────────────────────────────────────────────────
async function etapa5_telegram(qualified, dryRun) {
  log('📲', 'ETAPA 5 — Envio ao Telegram', 'bold');

  if (!qualified.length) {
    log('  ℹ️', 'Nenhuma oportunidade qualificada para enviar', 'gray');
    return 0;
  }

  let enviadas = 0;
  const bankroll = parseFloat(process.env.USER_BANKROLL || '1000');
  const db = loadDB();

  for (const item of qualified) {
    const { pred, market: m, cal } = item;
    // Deduplicação cross-pipeline: verifica se auto-monitor ou outro processo já enviou esta análise
    const notifKey = `${pred.sofascore_id || pred.match_name.replace(/\s+/g, '_').substring(0, 30)}_${m.market}`;
    if (_isAlreadyNotified(notifKey)) {
      log('  ⏭️', `${pred.match_name?.substring(0,30)} ${m.market} — já notificado nas últimas 24h (dedup)`, 'gray');
      continue;
    }

    const pieAccuracy = cal?.total >= GATE.PIE_MIN_SAMPLES
      ? Math.round((cal.hits / cal.total) * 100)
      : null;

    const horasAte = pred.match_date
      ? Math.max(0, Math.round((new Date(pred.match_date) - Date.now()) / 3_600_000))
      : null;

    // Reconstrói formato esperado pelo notifyPreLiveAnalysis
    const analysis = {
      matchData: {
        match:       pred.match_name,
        competition: pred.competition,
        date:        pred.match_date,
        match_id:    pred.sofascore_id || pred.match_id || '',
        // xG salvo na predição (disponível quando o runner já coletou via Quant/SofaScore)
        xg_home:     pred.xg_home  ?? null,
        xg_away:     pred.xg_away  ?? null,
      },
      match_name:       pred.match_name,
      confidence_score: m.confianca,
      probabilidade:    m.probabilidade,  // FIX: campo separado para Prob vs Conf no Telegram
      recommendation:   { action: 'BET' },
      top_bet: {
        market:  m.market,
        odds:    m.odds_minima,
        ev_pct:  `${m.ev_estimado}%`,
      },
      // xG no nível raiz para leitura direta pelo notifyPreLiveAnalysis
      xg_home: pred.xg_home ?? null,
      xg_away: pred.xg_away ?? null,
    };

    const { calcRiscoDisplay, calcRetornoPotencial } = await import('./prelive-analysis.js').catch(
      async () => await import('../src/workflows/prelive-analysis.js')
    );

    const risco     = calcRiscoDisplay(m.confianca, m.odds_minima, 'prelive');
    const stakePct  = risco.label === 'Baixo' ? 5 : risco.label === 'Médio' ? 3 : 1.5;
    const stakeInfo = calcRetornoPotencial(m.odds_minima, bankroll, stakePct);

    if (!dryRun) {
      // superbetUrl vem da ETAPA 4.5 — garantia de link real antes do envio
      await notifyPreLiveAnalysis(analysis, {
        stakeInfo, risco, pieAccuracy, horasAte, bankroll,
        directUrl: item.superbetUrl || null,
      }).catch(e => log('  ⚠️', `Telegram: ${e.message}`, 'yellow'));
      // Registra no notified-keys.json para evitar reenvio por outros processos (24h)
      _saveNotifiedKey(notifKey);
      enviadas++;
    } else {
      log('  🔵', `[DRY-RUN] ${pred.match_name} ${m.market} @ ${m.odds_minima}`, 'cyan');
      enviadas++;
    }

    await sleep(1000);
  }

  log('📲', `${enviadas} oportunidades enviadas ao Telegram`, 'green');
  return enviadas;
}

// ── ETAPA 6: Relatório do PIE ──────────────────────────────────────────────────
async function etapa6_relatorio(dryRun) {
  log('📊', 'ETAPA 6 — Relatório do PIE', 'bold');

  const stats = getStats();
  const db    = loadDB();
  const cal   = db.calibration || {};

  // Estatísticas de calibração
  const calibStats = Object.entries(cal)
    .filter(([, v]) => v.total >= 20)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([market, v]) => ({
      market,
      accuracy: Math.round(v.hits / v.total * 100),
      samples:  v.total,
    }));

  // Log no terminal sempre
  log('  📈', `Taxa global: ${stats.taxaAcerto || '—'}% (${stats.verificaveis || 0} verificáveis)`, 'cyan');
  log('  📚', `Lições: ${stats.licoesAtivas} ativas | Padrões: ${(db.positivePatterns||[]).filter(p=>p.active).length} positivos`, 'cyan');

  for (const { market, accuracy, samples } of calibStats.slice(0, 5)) {
    const bar = '█'.repeat(Math.round(accuracy / 10)) + '░'.repeat(10 - Math.round(accuracy / 10));
    log('  📊', `${market.padEnd(22)} ${accuracy}%  [${bar}]  (${samples} amostras)`, 'white');
  }

  if (!dryRun) {
    await notifyPIEStats(stats).catch(() => {});
  }

  log('📊', 'Relatório enviado', 'green');
  return stats;
}

// ── ETAPA 7: Resumo do Pipeline ────────────────────────────────────────────────
async function etapa7_resumo(resultados, dryRun) {
  log('✅', 'PIPELINE CONCLUÍDO', 'bold');

  const { coletadas, fechadas, injetados, qualified, enviadas } = resultados;
  const db    = loadDB();
  const total = (db.calibration?.['Over 1.5']?.total || 0) +
                (db.calibration?.['BTTS']?.total || 0) +
                (db.calibration?.['Over 2.5']?.total || 0);

  console.log('\n' + chalk.bold('─'.repeat(60)));
  console.log(chalk.bold.white('  Resumo do Pipeline Diário'));
  console.log(chalk.bold('─'.repeat(60)));
  console.log(`  📡 Datas coletadas:     ${coletadas}`);
  console.log(`  🔄 Resultados fechados: ${fechadas}`);
  console.log(`  🧠 Partidas no PIE:     ~${injetados} injetadas hoje`);
  console.log(`  🎯 Qualificadas gate:   ${qualified}`);
  console.log(`  📲 Enviadas Telegram:   ${enviadas}`);
  console.log(`  💾 Base total PIE:      ~${total} amostras (T1 markets)`);
  if (dryRun) console.log(chalk.yellow('\n  ⚠️  DRY-RUN: nenhum dado foi salvo'));
  console.log(chalk.bold('─'.repeat(60)) + '\n');

  // Snapshot diário do PIE — grava estado atual para histórico de evolução
  if (!dryRun) {
    try {
      const snap = savePieSnapshot();
      log('💾', `Snapshot PIE gravado — taxa global: ${snap.globalRate ?? '—'}%  |  ${Object.keys(snap.markets).length} mercados`, 'gray');
    } catch (e) {
      log('⚠️', `Snapshot PIE falhou: ${e.message}`, 'yellow');
    }
  }
}

// ── SofaScore Helpers ──────────────────────────────────────────────────────────
async function fetchResult(sofascoreId) {
  try {
    const { data } = await axios.get(`${SOFA_BASE}/event/${sofascoreId}`, {
      headers: SOFA_HEADERS, timeout: 8000,
    });
    const ev = data?.event;
    if (!ev) return null;
    const status = ev.status?.type;
    if (status !== 'finished') return { status, score: null };
    const home = ev.homeScore?.current;
    const away = ev.awayScore?.current;
    if (home == null || away == null) return { status, score: null };

    let stats = null;
    try {
      const s = await axios.get(`${SOFA_BASE}/event/${sofascoreId}/statistics`, {
        headers: SOFA_HEADERS, timeout: 6000,
      });
      const allPeriod = (s.data?.statistics || []).find(p => p.period === 'ALL')
        || (s.data?.statistics || []).at(-1);
      if (allPeriod?.groups) {
        stats = {};
        for (const g of allPeriod.groups) {
          for (const item of g.statisticsItems || []) {
            const key = item.name?.toLowerCase().replace(/\s+/g, '_');
            if (key) stats[key] = { home: parseFloat(item.home)||0, away: parseFloat(item.away)||0 };
          }
        }
      }
    } catch { /* stats opcionais */ }

    return { status: 'finished', score: { home: +home, away: +away }, stats };
  } catch { return null; }
}

async function trySearchByName(matchName, matchDate) {
  if (!matchName || !matchDate) return null;
  try {
    const date = matchDate.split('T')[0];
    const { data } = await axios.get(`${SOFA_BASE}/sport/football/scheduled-events/${date}`, {
      headers: SOFA_HEADERS, timeout: 8000,
    });
    const events = data?.events || [];
    const [hs, as] = matchName.split(/\s+vs\s+/i);
    if (!hs || !as) return null;
    const found = events.find(e => {
      const hn = e.homeTeam?.name?.toLowerCase() || '';
      const an = e.awayTeam?.name?.toLowerCase() || '';
      return hn.includes(hs.toLowerCase().slice(0,6)) && an.includes(as.toLowerCase().slice(0,6));
    });
    if (!found || found.status?.type !== 'finished') return null;
    const home = found.homeScore?.current;
    const away = found.awayScore?.current;
    if (home == null || away == null) return null;
    return { status: 'finished', score: { home: +home, away: +away }, stats: null };
  } catch { return null; }
}

function resolveMarket(market, rec, score, stats = null) {
  const total = score.home + score.away;
  const r     = String(rec || '').toUpperCase();

  switch (market) {
    case 'Over 0.5': return total > 0;
    case 'Over 1.5': return total > 1;
    case 'Over 2.5': return total > 2;
    case 'Over 3.5': return total > 3;
    case 'Over 4.5': return total > 4;
    case 'Under 1.5': return total < 2;
    case 'Under 2.5': return total < 3;
    case 'Under 3.5': return total < 4;
    case 'BTTS':
      return (r === 'NÃO' || r === 'NO' || r === 'NAO')
        ? !(score.home > 0 && score.away > 0)
        : (score.home > 0 && score.away > 0);
    case 'Home Win': case '1': return score.home > score.away;
    case 'Away Win': case '2': return score.away > score.home;
    case 'Draw':     case 'X': return score.home === score.away;
    case '1X': return score.home >= score.away;
    case 'X2': return score.away >= score.home;
    case '12': return score.home !== score.away;
    case 'Over Corners 6.5': case 'Over Corners 7.5': case 'Over Corners 8.5':
    case 'Over Corners 9.5': case 'Over Corners 10.5': {
      if (!stats) return null;
      const ck = stats['corner_kicks'] || stats['corners'];
      if (!ck) return null;
      const thr = parseFloat(market.match(/[\d.]+/)?.[0] || 8);
      return (ck.home + ck.away) > thr;
    }
    case 'YC 2.5': case 'YC 3.5': case 'YC 4.5':
    case 'Over YC 2.5': case 'Over YC 3.5': case 'Over YC 4.5': {
      if (!stats) return null;
      const yc = stats['yellow_cards'] || stats['yellow_card'];
      if (!yc) return null;
      const thr = parseFloat(market.match(/[\d.]+/)?.[0] || 2);
      return (yc.home + yc.away) > thr;
    }
    default: return null;
  }
}

// ── Orquestrador Principal ─────────────────────────────────────────────────────
export async function runDailyPipeline(opts = {}) {
  const dryRun   = opts.dryRun   || false;
  const datesN   = opts.datesBack || 2;
  const dates    = Array.from({ length: datesN }, (_, i) => dateStr(i + 1));

  console.log('\n' + chalk.bold('═'.repeat(64)));
  console.log(chalk.bold.cyan('  🗓️  PIPELINE DIÁRIO — Coleta + Análise + Aprendizado'));
  console.log(`  Datas: ${dates.join(', ')} | ${dryRun ? chalk.yellow('DRY-RUN') : chalk.green('REAL')}`);
  console.log(chalk.bold('═'.repeat(64)) + '\n');

  // ── Watchdog de rede ────────────────────────────────────────────────────────
  watchdog.start();

  // ── Verificação de recuperação pós-queda ────────────────────────────────────
  const prevState = logRecoveryStatus();
  const canResume = prevState && isRecoverable(prevState);
  if (canResume) {
    log('⚡', `Retomando execução interrompida (etapa: ${prevState.stage})`, 'yellow');
  }

  // ── Inicia run e salva checkpoint inicial ───────────────────────────────────
  const { runId } = startRun(dates);
  log('💾', `Run ID: ${runId}`, 'gray');

  let coletadas = prevState?.data?.coletadas ?? 0;
  let fechadas  = prevState?.data?.fechadas  ?? 0;
  let injetados = prevState?.data?.injetados ?? 0;

  // ── Etapas com checkpoint ───────────────────────────────────────────────────
  const skipTo = canResume ? prevState.stage : null;

  if (!skipTo || ['start','etapa1_coletar'].includes(skipTo)) {
    checkpoint('etapa1_coletar', { dates });
    coletadas = await etapa1_coletar(dates, dryRun);
    checkpoint('etapa1_done', { coletadas });
  }

  if (!skipTo || ['etapa1_done','etapa2_backfill'].includes(skipTo) || !canResume) {
    checkpoint('etapa2_backfill');
    fechadas = await etapa2_backfill(dryRun);
    checkpoint('etapa2_done', { fechadas });
  }

  if (!skipTo || !canResume || ['etapa2_done','etapa3_injetar'].includes(skipTo)) {
    checkpoint('etapa3_injetar');
    injetados = await etapa3_injetar(dates, dryRun);
    checkpoint('etapa3_done', { injetados });
  }

  checkpoint('etapa4_validar');
  const qualified  = await etapa4_validar();
  checkpoint('etapa4_done', { qualified: qualified.map(q => q.pred?.match_name) });

  checkpoint('etapa4b_urlGate');
  const gatedByUrl = dryRun ? qualified : await etapa4b_urlGate(qualified);
  checkpoint('etapa4b_done', { gatedByUrl: gatedByUrl.map(q => q.pred?.match_name) });

  checkpoint('etapa5_telegram');
  const enviadas = await etapa5_telegram(gatedByUrl, dryRun);
  checkpoint('etapa5_done', { enviadas });

  await etapa6_relatorio(dryRun);
  await etapa7_resumo({ coletadas, fechadas, injetados, qualified: qualified.length, enviadas }, dryRun);

  // ── Marca execução como concluída ───────────────────────────────────────────
  completeRun({ coletadas, fechadas, injetados, qualified: qualified.length, enviadas });
  log('💾', 'Estado salvo — execução concluída com sucesso', 'green');

  return { coletadas, fechadas, injetados, qualified: qualified.length, enviadas };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('daily-pipeline.js')) {
  import('dotenv/config').catch(() => {});

  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const report  = args.includes('--report');
  const datesArg = args.find(a => a.startsWith('--dates='));
  const datesBack = datesArg ? parseInt(datesArg.split('=')[1]) : 2;

  if (report) {
    // Só envia relatório PIE
    import('dotenv/config').catch(() => {});
    await etapa6_relatorio(false);
  } else {
    await runDailyPipeline({ dryRun, datesBack });
  }
}
