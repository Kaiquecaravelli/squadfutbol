/**
 * Obsidian Integration — Apostas Futebol Vault
 *
 * Estrutura do vault:
 *   Apostas Futebol/
 *   ├── 📊 Dashboard.md          ← Hub central (Dataview dinâmico)
 *   ├── 📅 Agenda Hoje.md        ← Jogos do dia (atualiza a cada scan)
 *   ├── 🔴 Sessão Atual.md       ← Status em tempo real do bot
 *   ├── 🧠 Padrões Aprendidos.md ← Lições PIE acumuladas
 *   ├── 📈 ROI e Performance.md  ← Métricas de longo prazo
 *   ├── Análises/YYYY-MM/        ← Pré-live (uma nota por jogo aprovado)
 *   ├── Live/YYYY-MM/            ← Oportunidades in-play e 2T
 *   ├── Scans/YYYY-MM/           ← Scan completo de todos os agentes
 *   └── Resultados/YYYY-MM/      ← Comparativo predição vs realidade
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── Helpers base ──────────────────────────────────────────────────────────────

export function isObsidianConfigured() {
  const v = process.env.OBSIDIAN_VAULT_PATH;
  return !!(v && v.trim() && v !== 'seu_caminho_aqui');
}

function _base() {
  return join(
    process.env.OBSIDIAN_VAULT_PATH.trim(),
    process.env.OBSIDIAN_FOLDER || 'Apostas Futebol',
  );
}

function _dir(...parts) {
  const d = join(_base(), ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

function _write(filePath, content) {
  try {
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  } catch (err) {
    console.warn(`[Obsidian] Falha ao salvar ${filePath}: ${err.message}`);
    return null;
  }
}

function _safe(name) {
  return (name || 'partida').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function _now() {
  const d = new Date();
  return {
    iso:      d.toISOString(),
    date:     d.toISOString().slice(0, 10),
    month:    d.toISOString().slice(0, 7),
    time:     d.toTimeString().slice(0, 5),
    stamp:    d.toTimeString().slice(0, 5).replace(':', ''),
    display:  d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    weekday:  d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }),
  };
}

function _fmtTime(dateStr) {
  if (!dateStr) return '—';
  try { return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

function _riskBadge(prob, conf) {
  const p = Number(prob) || 0;
  const c = Number(conf) || 0;
  if (p >= 90 && c >= 85) return '🟢 Baixo';
  if (p >= 80 && c >= 75) return '🟡 Médio';
  return '🔴 Alto';
}

function _recIcon(rec) {
  const r = (rec || '').toUpperCase();
  if (r === 'SIM' || r === 'APOSTAR' || r === 'OVER' || r === 'UNDER') return '✅';
  if (r === 'NÃO' || r === 'NAO') return '❌';
  return '⚠️';
}

// ── Frontmatter builder ───────────────────────────────────────────────────────

function _fm(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      v.forEach((i) => lines.push(`  - ${i}`));
    } else {
      const str = String(v).includes(':') || String(v).includes('"') ? `"${String(v).replace(/"/g, "'")}"` : v;
      lines.push(`${k}: ${str}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DASHBOARD — Hub central com Dataview dinâmico
// ═══════════════════════════════════════════════════════════════════════════════

export function rebuildDashboard(extraStats = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '📊 Dashboard.md');

  const content = `# ⚽ Apostas Futebol — Hub Central

> [!info] Sistema Ativo · ${t.display}
> Bot em execução · Análise automática 24h · Gate: Prob ≥ 80% · Confiança ≥ 75%

---

## 🎯 Hoje — ${t.weekday.toUpperCase()}

\`\`\`dataview
TABLE WITHOUT ID
  "⚽ " + partida AS "Partida",
  competicao AS "Liga",
  horario AS "⏰",
  mercado AS "Mercado",
  probabilidade + "%" AS "Prob",
  confianca + "%" AS "Conf",
  choice(resultado = "pendente", "⏳ Aguardando", choice(resultado = "green", "✅ Green", choice(resultado = "red", "❌ Red", "🔍 " + resultado))) AS "Resultado"
FROM "Apostas Futebol/Análises"
WHERE data = date(today)
SORT horario ASC
\`\`\`

---

## 📊 Performance Geral

\`\`\`dataview
TABLE WITHOUT ID
  total AS "📋 Total",
  acertos AS "✅ Acertos",
  erros AS "❌ Erros",
  (round(acertos / (acertos + erros) * 100, 1)) + "%" AS "🎯 Acurácia"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado"
FLATTEN length(rows) AS total
FLATTEN sum(rows.acertos) AS acertos
FLATTEN sum(rows.erros) AS erros
LIMIT 1
\`\`\`

---

## 🏆 Acurácia por Mercado

\`\`\`dataview
TABLE WITHOUT ID
  mercado_principal AS "Mercado",
  length(rows) AS "Total",
  sum(rows.acertos) AS "✅",
  sum(rows.erros) AS "❌",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Taxa"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0
GROUP BY mercado_principal
SORT sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) DESC
\`\`\`

---

## 📅 Últimas Análises (7 dias)

\`\`\`dataview
TABLE WITHOUT ID
  data AS "Data",
  "⚽ " + partida AS "Partida",
  competicao AS "Liga",
  mercado AS "Mercado",
  probabilidade + "%" AS "Prob",
  choice(resultado = "pendente", "⏳", choice(resultado = "green", "✅ Green", choice(resultado = "red", "❌ Red", "🔍"))) AS "Resultado"
FROM "Apostas Futebol/Análises"
WHERE data >= date(today) - dur(7 days)
SORT data DESC, horario DESC
LIMIT 30
\`\`\`

---

## 🔴 Live & 2T — Recentes

\`\`\`dataview
TABLE WITHOUT ID
  data AS "Data",
  "⚽ " + partida AS "Partida",
  minuto + "'" AS "Min",
  placar AS "Placar",
  mercados_aprovados AS "Mercados"
FROM "Apostas Futebol/Live"
WHERE data >= date(today) - dur(2 days)
SORT file.mtime DESC
LIMIT 10
\`\`\`

---

## 🏅 Top Competições

\`\`\`dataview
TABLE WITHOUT ID
  competicao AS "Liga",
  length(rows) AS "Análises",
  round(sum(rows.probabilidade) / length(rows), 0) + "%" AS "Prob Média",
  sum(rows.acertos) + "/" + (sum(rows.acertos) + sum(rows.erros)) AS "Acertos"
FROM "Apostas Futebol/Análises"
GROUP BY competicao
SORT length(rows) DESC
LIMIT 8
\`\`\`

---

## 🧭 Navegação Rápida

| | |
|---|---|
| 📅 [[📅 Agenda Hoje]] | Jogos analisados hoje |
| 🔴 [[🔴 Sessão Atual]] | Status em tempo real do bot |
| 🧠 [[🧠 Padrões Aprendidos]] | Lições PIE acumuladas |
| 📈 [[📈 ROI e Performance]] | Métricas de longo prazo |

---

> *Atualizado automaticamente pelo Betting Analysis Squad · ${t.display}*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. AGENDA HOJE — atualizada a cada scan de pré-live
// ═══════════════════════════════════════════════════════════════════════════════

export function updateAgendaHoje(matches = [], approvedMatches = []) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '📅 Agenda Hoje.md');

  const approvedIds = new Set(approvedMatches.map((a) => a.matchData?.match || a.match));
  const total       = matches.length;
  const aprovados   = approvedMatches.length;

  const matchLines = matches.map((m, i) => {
    const hora    = m.match_time || _fmtTime(m.date);
    const nome    = m.match || `${m.home_team || '?'} vs ${m.away_team || '?'}`;
    const comp    = m.competition || '—';
    const isAprov = approvedIds.has(nome);
    const status  = isAprov ? '🟢 Oportunidade' : '⚪ Sem sinal';
    return `| ${String(i + 1).padStart(2)} | ⏰ ${hora} | **${nome}** | ${comp} | ${status} |`;
  });

  const content = `# 📅 Agenda Hoje — ${t.weekday.toUpperCase()}

> [!info] Última atualização: ${t.display}
> **${total}** jogos monitorados · **${aprovados}** oportunidades identificadas

---

## 📋 Grade Completa

| # | Hora | Partida | Competição | Status |
|---|------|---------|-----------|--------|
${matchLines.join('\n') || '| — | — | *Nenhum jogo encontrado* | — | — |'}

---

## ✅ Oportunidades do Dia

\`\`\`dataview
TABLE WITHOUT ID
  horario AS "⏰ Hora",
  "⚽ " + partida AS "Partida",
  mercado AS "Mercado",
  probabilidade + "%" AS "Prob",
  confianca + "%" AS "Conf",
  choice(resultado = "pendente", "⏳", choice(resultado = "green", "✅ Green", "❌ Red")) AS "Resultado"
FROM "Apostas Futebol/Análises"
WHERE data = date(today)
SORT horario ASC
\`\`\`

---

> *[[📊 Dashboard]] · [[🔴 Sessão Atual]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SESSÃO ATUAL — status em tempo real do bot
// ═══════════════════════════════════════════════════════════════════════════════

export function updateSessaoAtual({ fase, scanned = 0, opportunities = 0, lastMatch = '', quota = false, liveScan = false, live2t = false } = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '🔴 Sessão Atual.md');

  const quotaBadge   = quota   ? '> [!warning] ⚠️ Cota Gemini temporariamente esgotada — análises pausadas\n\n' : '';
  const liveStatus   = liveScan ? '🔴 Live In-Play' : '⚪ Aguardando';
  const live2tStatus = live2t   ? '🟡 Live 2T' : '⚪ Aguardando';

  const content = `# 🔴 Sessão Atual — Bot em Execução

${quotaBadge}> [!info] Status: **${fase || 'Monitorando'}** · ${t.display}

---

## 📡 Estado dos Funnels

| Funil | Status | Intervalo |
|-------|--------|-----------|
| 🟢 Pré-Live | ✅ Ativo | A cada 60 min |
| ${liveStatus} | ${liveScan ? '✅ Ativo' : '⏸ Aguardando'} | A cada 15 min |
| ${live2tStatus} | ${live2t ? '✅ Ativo' : '⏸ Aguardando'} | A cada 10 min |

---

## 📊 Ciclo Atual

| Métrica | Valor |
|---------|-------|
| Jogos analisados | **${scanned}** |
| Oportunidades encontradas | **${opportunities}** |
| Último jogo | ${lastMatch || '—'} |
| Atualizado em | ${t.display} |

---

## 🎯 Oportunidades Ativas (Pendentes)

\`\`\`dataview
TABLE WITHOUT ID
  data AS "Data",
  horario AS "⏰",
  "⚽ " + partida AS "Partida",
  mercado AS "Mercado",
  probabilidade + "%" AS "Prob",
  risco AS "Risco"
FROM "Apostas Futebol/Análises"
WHERE resultado = "pendente"
SORT data DESC, horario ASC
\`\`\`

---

## 🔴 Live Recente

\`\`\`dataview
TABLE WITHOUT ID
  "⚽ " + partida AS "Partida",
  minuto + "'" AS "Min",
  placar AS "Placar",
  mercados_aprovados AS "Mercados"
FROM "Apostas Futebol/Live"
WHERE data = date(today)
SORT file.mtime DESC
LIMIT 5
\`\`\`

---

> *[[📊 Dashboard]] · [[📅 Agenda Hoje]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PADRÕES APRENDIDOS — lições PIE em tempo real
// ═══════════════════════════════════════════════════════════════════════════════

export function updatePadroesAprendidos(lessons = [], calibration = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '🧠 Padrões Aprendidos.md');

  // Agrupa lições por mercado
  const byMarket = {};
  for (const l of lessons) {
    const m = l.market || 'Geral';
    if (!byMarket[m]) byMarket[m] = [];
    byMarket[m].push(l);
  }

  const marketIcons = {
    'Ambas Marcam': '⚽', 'BTTS': '⚽',
    'Gols': '🥅', 'Over': '🥅', 'Under': '🥅',
    'Escanteios': '⛳', 'Cartões': '🟨',
    'Dupla Chance': '🔄', 'Placar Exato': '🎯',
    'Resultado Final': '🏆',
  };

  const marketSections = Object.entries(byMarket).map(([market, ls]) => {
    const icon = marketIcons[market] || '📊';
    const calib = calibration[market];
    const calibLine = calib
      ? `> **Acurácia histórica:** ${(calib.hits / calib.total * 100).toFixed(1)}% em ${calib.total} amostras`
      : '';

    const lessonLines = ls
      .sort((a, b) => (b.weight || 1) - (a.weight || 1))
      .map((l) => {
        const weight = l.weight >= 2 ? '🔴 Crítico' : '🟡 Importante';
        const count  = l.applied_count > 0 ? ` · aplicada ${l.applied_count}x` : '';
        return `> [!tip] ${weight}${count}\n> ${l.directive}`;
      })
      .join('\n\n');

    return `### ${icon} ${market}\n\n${calibLine ? calibLine + '\n\n' : ''}${lessonLines}`;
  }).join('\n\n---\n\n');

  const content = `# 🧠 Padrões Aprendidos pelo Time

> [!info] PIE — Protocolo de Inteligência Evolutiva · Atualizado ${t.display}
> **${lessons.length}** lições ativas · Geradas automaticamente a partir de resultados reais

---

## 📖 Lições por Mercado

${marketSections || '> *Nenhuma lição registrada ainda. As lições são geradas automaticamente após cada resultado.*'}

---

## 📊 Calibração por Mercado

\`\`\`dataview
TABLE WITHOUT ID
  mercado_principal AS "Mercado",
  length(rows) AS "Amostras",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Acurácia",
  round(sum(rows.probabilidade) / length(rows), 0) + "%" AS "Prob Média"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0
GROUP BY mercado_principal
SORT sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) DESC
\`\`\`

---

## 🏆 Padrões por Competição

\`\`\`dataview
TABLE WITHOUT ID
  competicao AS "Competição",
  length(rows) AS "Jogos",
  sum(rows.acertos) + "/" + (sum(rows.acertos) + sum(rows.erros)) AS "Acertos",
  round(sum(rows.probabilidade) / length(rows), 0) + "%" AS "Prob Média"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado"
GROUP BY competicao
SORT length(rows) DESC
LIMIT 10
\`\`\`

---

> *[[📊 Dashboard]] · [[📈 ROI e Performance]] · [[🔴 Sessão Atual]]*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ROI E PERFORMANCE — métricas de longo prazo
// ═══════════════════════════════════════════════════════════════════════════════

export function updateRoiPerformance(stats = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '📈 ROI e Performance.md');

  const acuracia = stats.verificaveis > 0
    ? ((stats.acertos / stats.verificaveis) * 100).toFixed(1)
    : '—';

  const content = `# 📈 ROI & Performance — Longo Prazo

> [!info] Métricas acumuladas · ${t.display}

---

## 🎯 Resumo Geral

| Métrica | Valor |
|---------|-------|
| Total de análises | **${stats.total || 0}** |
| Verificáveis | **${stats.verificaveis || 0}** |
| ✅ Acertos | **${stats.acertos || 0}** |
| ❌ Erros | **${stats.erros || 0}** |
| 🎯 Taxa de acerto | **${acuracia}%** |
| 📚 Lições ativas | **${stats.licoesAtivas || 0}** |

---

## 📊 Acurácia ao Longo do Tempo

\`\`\`dataview
TABLE WITHOUT ID
  dateformat(date, "dd/MM") AS "Data",
  length(rows) AS "Jogos",
  sum(rows.acertos) AS "✅",
  sum(rows.erros) AS "❌",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Acurácia"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0
GROUP BY data
SORT data DESC
LIMIT 14
\`\`\`

---

## 🏅 Ranking por Mercado

\`\`\`dataview
TABLE WITHOUT ID
  mercado_principal AS "Mercado",
  length(rows) AS "Total",
  sum(rows.acertos) AS "✅ Acertos",
  sum(rows.erros) AS "❌ Erros",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Taxa",
  round(sum(rows.probabilidade) / length(rows), 0) + "%" AS "Prob Média"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0
GROUP BY mercado_principal
SORT sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) DESC
\`\`\`

---

## 🌍 Ranking por Competição

\`\`\`dataview
TABLE WITHOUT ID
  competicao AS "Competição",
  length(rows) AS "Jogos",
  sum(rows.acertos) AS "✅",
  sum(rows.erros) AS "❌",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Taxa"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0
GROUP BY competicao
SORT sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) DESC
LIMIT 12
\`\`\`

---

## 📉 Análise de Risco

\`\`\`dataview
TABLE WITHOUT ID
  risco AS "Risco",
  length(rows) AS "Total",
  sum(rows.acertos) AS "✅",
  round(sum(rows.acertos) / (sum(rows.acertos) + sum(rows.erros)) * 100, 1) + "%" AS "Taxa"
FROM "Apostas Futebol/Resultados"
WHERE tipo = "resultado" AND (acertos + erros) > 0 AND risco != ""
GROUP BY risco
\`\`\`

---

> *[[📊 Dashboard]] · [[🧠 Padrões Aprendidos]] · [[📅 Agenda Hoje]]*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ANÁLISE PRÉ-LIVE — nota individual por jogo aprovado (Análises/YYYY-MM/)
// ═══════════════════════════════════════════════════════════════════════════════

export function saveAnalisePreLive(matchData, approvedResults = []) {
  if (!isObsidianConfigured() || !approvedResults.length) return null;
  const t     = _now();
  const dir   = _dir('Análises', t.month);
  const fname = `${t.date}_${_safe(matchData.match)}_${t.stamp}.md`;
  const path  = join(dir, fname);

  const hora      = matchData.date ? _fmtTime(matchData.date) : (matchData.match_time || '—');
  const comp      = matchData.competition || 'N/A';
  const compTag   = comp.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const mercados  = approvedResults.map((r) => r.mercado ?? r.market ?? '').join(', ');
  const bestProb  = Math.max(...approvedResults.map((r) => Number(r.probabilidade || 0)));
  const bestConf  = Math.max(...approvedResults.map((r) => Number(r.confianca || 0)));
  const risco     = _riskBadge(bestProb, bestConf);

  const fm = _fm({
    partida:          matchData.match || '',
    competicao:       comp,
    data:             t.date,
    horario:          hora,
    mercado:          mercados,
    mercado_principal: approvedResults[0]?.mercado ?? approvedResults[0]?.market ?? '',
    probabilidade:    bestProb,
    confianca:        bestConf,
    risco:            risco.replace(/[🟢🟡🔴]/g, '').trim(),
    resultado:        'pendente',
    acertos:          0,
    erros:            0,
    tipo:             'analise-pre-live',
    tags:             ['analise', 'pre-live', 'futebol', compTag].filter(Boolean),
  });

  const mercadoBlocks = approvedResults.map((r) => {
    const mercado = r.mercado ?? r.market ?? '—';
    const rec     = r.recomendacao ?? r.recommendation ?? '—';
    const prob    = r.probabilidade ?? 0;
    const conf    = r.confianca ?? 0;
    const icon    = _recIcon(rec);
    const risk    = _riskBadge(prob, conf);
    const oddsLine = r.odds_minima_recomendada ? `> **Odds mínima:** ${r.odds_minima_recomendada}` : '';
    const justLine = (r.justificativa || r.reasoning) ? `>\n> *${r.justificativa ?? r.reasoning}*` : '';

    return `> [!tip] ${icon} **${mercado}** → ${rec}
> **Probabilidade:** ${prob}%  ·  **Confiança:** ${conf}%  ·  ${risk}
${oddsLine}${justLine}`;
  }).join('\n\n');

  // Dados dos times
  const home = matchData.home || {};
  const away = matchData.away || {};
  const hasStats = home.team || away.goals_scored_avg;

  const statsTable = hasStats ? `
## 📊 Dados dos Times

| | **${home.team || 'Casa'}** | **${away.team || 'Visitante'}** |
|---|---|---|
${home.goals_scored_avg != null ? `| Gols marcados/jogo | ${home.goals_scored_avg} | ${away.goals_scored_avg ?? '—'} |` : ''}
${home.goals_conceded_avg != null ? `| Gols sofridos/jogo | ${home.goals_conceded_avg} | ${away.goals_conceded_avg ?? '—'} |` : ''}
${home.form ? `| Forma (5j) | \`${home.form}\` | \`${away.form || '—'}\` |` : ''}
${home.btts_pct != null ? `| BTTS% | ${home.btts_pct}% | ${away.btts_pct ?? '—'}% |` : ''}
${home.corners_avg != null ? `| Escanteios/jogo | ${home.corners_avg} | ${away.corners_avg ?? '—'} |` : ''}
` : '';

  const h2hSection = matchData.h2h?.length ? `
## 🔄 H2H (últimos confrontos)

${matchData.h2h.slice(0, 5).map((h) =>
    `- ${h.date || ''} · **${h.home_team || ''}** ${h.home_goals ?? '?'}–${h.away_goals ?? '?'} **${h.away_team || ''}**`
  ).join('\n')}
` : '';

  const content = `${fm}

# ⚽ ${matchData.match || 'Análise'}

> **${comp}**  ·  📅 ${t.date}  ·  ⏰ ${hora}

---

## 🎯 Mercados Aprovados

${mercadoBlocks}

---
${statsTable}${h2hSection}
## 📝 Resultado

> [!note] Aguardando resultado
> Use \`/resultado N X-X\` no grupo para registrar o placar.

| Campo | Valor |
|-------|-------|
| Resultado | ⏳ Pendente |
| Placar | — |
| Atualizado | — |

---

> *[[📊 Dashboard]] · [[📅 Agenda Hoje]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(path, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. OPORTUNIDADE LIVE — nota por jogo ao vivo (Live/YYYY-MM/)
// ═══════════════════════════════════════════════════════════════════════════════

export function saveLiveOpportunity(liveData, markets = [], type = 'live') {
  if (!isObsidianConfigured()) return null;
  const t      = _now();
  const label  = type === 'live-2t' ? 'LIVE 2T' : 'LIVE IN-PLAY';
  const icon   = type === 'live-2t' ? '🟡' : '🔴';
  const dir    = _dir('Live', t.month);
  const match  = liveData.match || `${liveData.home_team || '?'} vs ${liveData.away_team || '?'}`;
  const fname  = `${t.date}_${type}_${_safe(match)}_${t.stamp}.md`;
  const path   = join(dir, fname);

  const minuto = liveData.minuto ?? liveData.minute ?? '?';
  const placar = liveData.placar ?? `${liveData.score_home ?? '?'}-${liveData.score_away ?? '?'}`;
  const comp   = liveData.competition || 'N/A';

  const fm = _fm({
    partida:           match,
    competicao:        comp,
    data:              t.date,
    minuto:            minuto,
    placar:            placar,
    tipo:              type,
    mercados_aprovados: markets.length,
    tags:              ['live', type, 'futebol'],
  });

  const ls = liveData.live_stats || {};
  const statsLines = [
    ls.posse_casa != null         ? `| Posse | ${ls.posse_casa}% | ${ls.posse_fora ?? '—'}% |` : '',
    ls.chutes_alvo_casa != null   ? `| Chutes a gol | ${ls.chutes_alvo_casa} | ${ls.chutes_alvo_fora ?? '—'} |` : '',
    ls.escanteios_casa != null    ? `| Escanteios | ${ls.escanteios_casa} | ${ls.escanteios_fora ?? '—'} |` : '',
    ls.cartoes_amarelos_casa != null ? `| Cartões amarelos | ${ls.cartoes_amarelos_casa} | ${ls.cartoes_amarelos_fora ?? '—'} |` : '',
    liveData.xg_home != null      ? `| xG | ${liveData.xg_home} | ${liveData.xg_away ?? '—'} |` : '',
  ].filter(Boolean);

  const statsTable = statsLines.length ? `
## 📡 Estatísticas ao Vivo

| | **${liveData.home_team || 'Casa'}** | **${liveData.away_team || 'Visitante'}** |
|---|---|---|
${statsLines.join('\n')}
` : '';

  const mercadoBlocks = markets.map((m) => {
    const mercado = m.mercado ?? m.market ?? '—';
    const rec     = m.recomendacao ?? m.recommendation ?? '—';
    const prob    = m.probabilidade ?? 0;
    const conf    = m.confianca ?? 0;
    const risk    = _riskBadge(prob, conf);
    const odds    = m.odds_minima_recomendada ? `> **Odds mínima:** ${m.odds_minima_recomendada}` : '';

    return `> [!success] ${_recIcon(rec)} **${mercado}** → ${rec}
> **Probabilidade:** ${prob}%  ·  **Confiança:** ${conf}%  ·  ${risk}
${odds}`;
  }).join('\n\n');

  const content = `${fm}

# ${icon} ${label} — ${match}

> **${comp}**  ·  ⏱ **${minuto}'**  ·  📊 **${placar}**

---

## 🎯 Mercados Aprovados

${mercadoBlocks}

---
${statsTable}
${liveData.home?.form ? `**Forma Casa:** \`${liveData.home.form}\`  ·  **Forma Visitante:** \`${liveData.away?.form || '—'}\`` : ''}

---

> *${icon} Oportunidade gerada em ${t.display}*
>
> *[[📊 Dashboard]] · [[🔴 Sessão Atual]]*
`;

  return _write(path, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. SCAN COMPLETO — todos os agentes, aprovados + rejeitados (Scans/YYYY-MM/)
// ═══════════════════════════════════════════════════════════════════════════════

export function saveMatchScan(matchData, allResults = [], approvedResults = []) {
  if (!isObsidianConfigured()) return null;
  const t     = _now();
  const dir   = _dir('Scans', t.month);
  const fname = `${t.date}_${_safe(matchData.match)}_${t.stamp}.md`;
  const path  = join(dir, fname);

  const hora = matchData.date ? _fmtTime(matchData.date) : (matchData.match_time || '—');
  const comp = matchData.competition || 'N/A';
  const approvedMarkets = new Set(approvedResults.map((r) => r.mercado ?? r.market));

  const fm = _fm({
    partida:        matchData.match || '',
    competicao:     comp,
    data:           t.date,
    horario:        hora,
    tipo:           'scan-completo',
    total_agentes:  allResults.length,
    aprovados:      approvedResults.length,
    rejeitados:     allResults.length - approvedResults.length,
    tags:           ['scan', 'pre-live', 'futebol'],
  });

  const home = matchData.home || {};
  const away = matchData.away || {};

  const statsRows = [
    home.goals_scored_avg != null ? `| Gols marcados/jogo | ${home.goals_scored_avg} | ${away.goals_scored_avg ?? '—'} |` : '',
    home.goals_conceded_avg != null ? `| Gols sofridos/jogo | ${home.goals_conceded_avg} | ${away.goals_conceded_avg ?? '—'} |` : '',
    home.form ? `| Forma (5j) | \`${home.form}\` | \`${away.form || '—'}\` |` : '',
    home.btts_pct != null ? `| BTTS% | ${home.btts_pct}% | ${away.btts_pct ?? '—'}% |` : '',
    home.corners_avg != null ? `| Escanteios/jogo | ${home.corners_avg} | ${away.corners_avg ?? '—'} |` : '',
    home.yellow_cards_avg != null ? `| Cartões/jogo | ${home.yellow_cards_avg} | ${away.yellow_cards_avg ?? '—'} |` : '',
  ].filter(Boolean);

  const agentRows = allResults.map((r) => {
    const mercado  = r.mercado ?? r.market ?? '—';
    const prob     = r.probabilidade ?? r.probability ?? 0;
    const conf     = r.confianca ?? r.confidence ?? 0;
    const rec      = r.recomendacao ?? r.recommendation ?? '—';
    const approved = approvedMarkets.has(mercado);
    const status   = approved ? '✅ Aprovado' : '❌ Rejeitado';
    const risk     = _riskBadge(prob, conf);
    return `| ${status} | **${mercado}** | ${rec} | ${prob}% | ${conf}% | ${risk} |`;
  });

  const h2hLines = (matchData.h2h || []).slice(0, 5).map((h) =>
    `- ${h.date || ''} · **${h.home_team || ''}** ${h.home_goals ?? '?'}–${h.away_goals ?? '?'} **${h.away_team || ''}**`
  );

  const content = `${fm}

# 🔍 Scan Completo — ${matchData.match || 'Partida'}

> **${comp}**  ·  📅 ${t.date}  ·  ⏰ ${hora}
> ${approvedResults.length}/${allResults.length} agentes aprovados

---

## 🤖 Resultado de Todos os Agentes

| Status | Mercado | Recomendação | Prob | Confiança | Risco |
|--------|---------|-------------|------|-----------|-------|
${agentRows.join('\n') || '| — | *Nenhum resultado* | — | — | — | — |'}

---

## 📊 Dados Coletados

${statsRows.length ? `| | **${home.team || 'Casa'}** | **${away.team || 'Visitante'}** |
|---|---|---|
${statsRows.join('\n')}` : '*Dados não disponíveis*'}

${h2hLines.length ? `\n## 🔄 H2H\n\n${h2hLines.join('\n')}` : ''}

---

> *Scan gerado em ${t.display} · [[📊 Dashboard]]*
`;

  return _write(path, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. RESULTADO — comparativo predição vs realidade (Resultados/YYYY-MM/)
// ═══════════════════════════════════════════════════════════════════════════════

export function saveMatchResult(matchData, placar, analyses = [], pieResult = null) {
  if (!isObsidianConfigured()) return null;
  const t    = _now();
  const dir  = _dir('Resultados', t.month);
  const match = matchData.match || 'partida';
  const fname = `${t.date}_resultado_${_safe(match)}_${t.stamp}.md`;
  const path  = join(dir, fname);

  // Calcular acertos
  const parts     = placar.split(/[-x×:]/i).map((s) => parseInt(s.trim(), 10));
  const homeGoals = isNaN(parts[0]) ? 0 : parts[0];
  const awayGoals = isNaN(parts[1]) ? 0 : parts[1];
  const totalGols = homeGoals + awayGoals;
  const ambosMarcaram = homeGoals > 0 && awayGoals > 0;

  let acertos = 0, erros = 0;
  const resultRows = [];

  for (const a of analyses) {
    const mercado = a.market || a.mercado || '';
    const rec     = a.recommendation || a.recomendacao || '';
    const prob    = a.probabilidade ?? 0;
    const mu = mercado.toUpperCase();
    const ru = rec.toUpperCase();
    let acertou = null;

    if (mu.includes('BTTS') || mu.includes('AMBAS')) {
      acertou = (ru === 'SIM' || ru === 'APOSTAR') ? ambosMarcaram : !ambosMarcaram;
    } else if (mu.includes('OVER') || mu.includes('UNDER') || mu.includes('GOLS') || mu.includes('TOTAL')) {
      const linha = parseFloat(mu.match(/[\d.]+/)?.[0] ?? '2.5');
      acertou = (ru.includes('OVER') || ru.includes('MAIS')) ? totalGols > linha : totalGols < linha;
    } else if (mu.includes('DUPLA') || mu.includes('CHANCE')) {
      if (ru === '1X') acertou = homeGoals >= awayGoals;
      else if (ru === 'X2') acertou = awayGoals >= homeGoals;
      else if (ru === '12') acertou = homeGoals !== awayGoals;
    } else if (mu.includes('PLACAR') || mu.includes('EXATO')) {
      const m = rec.match(/(\d+)\s*[x×\-:]\s*(\d+)/i);
      if (m) acertou = parseInt(m[1]) === homeGoals && parseInt(m[2]) === awayGoals;
    }

    if (acertou === true)  acertos++;
    if (acertou === false) erros++;

    const icon   = acertou === true ? '✅' : acertou === false ? '❌' : '🔍';
    const market = a.mercado ?? a.market ?? '—';
    resultRows.push(`| ${icon} | **${market}** | ${rec} | ${prob}% |`);
  }

  const taxaAcerto = (acertos + erros) > 0
    ? ((acertos / (acertos + erros)) * 100).toFixed(0) + '%'
    : '—';

  const resultIcon  = acertos > erros ? '✅' : acertos === erros ? '⚠️' : '❌';
  const calloutType = acertos > erros ? 'success' : acertos === erros ? 'warning' : 'danger';

  const lessonLines = pieResult?.newLessons?.length
    ? pieResult.newLessons.map((l) => `> - **${l.market || ''}:** *${l.directive}*`).join('\n')
    : '';

  const fm = _fm({
    partida:           match,
    competicao:        matchData.competition || '',
    data:              t.date,
    placar:            placar,
    tipo:              'resultado',
    acertos:           acertos,
    erros:             erros,
    taxa_acerto:       taxaAcerto,
    mercado_principal: analyses[0]?.market || analyses[0]?.mercado || '',
    probabilidade:     analyses[0]?.probabilidade ?? 0,
    tags:              ['resultado', 'futebol'],
  });

  const content = `${fm}

# 📊 Resultado — ${match}

> [!${calloutType}] ${resultIcon} Placar: **${homeGoals} × ${awayGoals}** · Acurácia: **${taxaAcerto}** (${acertos}✅ ${erros}❌)

---

## 📋 Comparativo Predição vs Realidade

| | Mercado | Recomendação | Prob |
|--|---------|-------------|------|
${resultRows.join('\n') || '| 🔍 | *Sem análise registrada* | — | — |'}

---

${lessonLines ? `## 🧠 Lições Geradas pelo PIE

> [!tip] Aprendizado automático
${lessonLines}

---
` : ''}

> *Resultado registrado em ${t.display} · [[📊 Dashboard]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(path, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. COMPAT — funções legadas mantidas para não quebrar chamadas existentes
// ═══════════════════════════════════════════════════════════════════════════════

/** @deprecated Use saveAnalisePreLive */
export function saveToObsidian({ matchData, report, confidenceScore, recommendation, topBet, riskAssessment, quantAnalysis }) {
  if (!isObsidianConfigured()) return null;
  return saveAnalisePreLive(matchData, [{
    mercado: topBet?.market || 'Geral',
    recomendacao: recommendation?.label || recommendation?.action || '—',
    probabilidade: confidenceScore || 0,
    confianca: confidenceScore || 0,
    odds_minima_recomendada: topBet?.odds || null,
    justificativa: report?.slice(0, 200) || '',
  }]);
}

/** Atualiza o campo resultado numa nota existente */
export function updateObsidianResult(filePath, result) {
  if (!filePath || !existsSync(filePath)) return;
  try {
    let content = readFileSync(filePath, 'utf-8');
    content = content.replace(/^resultado: .+$/m, `resultado: ${result}`);
    // Atualiza também o bloco visual de resultado
    content = content.replace(
      /\| Resultado \| ⏳ Pendente \|/,
      `| Resultado | ${result === 'green' ? '✅ Green' : result === 'red' ? '❌ Red' : result} |`
    );
    writeFileSync(filePath, content, 'utf-8');
    console.log(`📓 Obsidian: resultado atualizado → ${result}`);
  } catch { /* silencioso */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. PROTOCOLO SNIPER — precisão por banda de confiança
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Atualiza (ou cria) a nota "🎯 Protocolo Sniper.md" no vault com os
 * thresholds calculados pelo sniper-protocol.js.
 *
 * @param {object} sniperData   { thresholds, totalShots, totalHits, totalAbstained, overallAcc, abstainRate, marketsOnTarget, totalMatches }
 */
export function updateSniperProtocol(sniperData = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '🎯 Protocolo Sniper.md');

  const { thresholds = {}, totalShots = 0, totalHits = 0, totalAbstained = 0,
          overallAcc = 0, abstainRate = 0, marketsOnTarget = 0, totalMatches = 0 } = sniperData;

  const BAND_EMOJI = { COLD: '🔵', WARM: '🟡', HOT: '🟢', ELITE: '🔴' };
  const BAND_DESC  = { COLD: '1-2 sinais', WARM: '3-4 sinais', HOT: '5-6 sinais', ELITE: '7+ sinais' };

  const marketRows = Object.entries(thresholds).map(([market, data]) => {
    const bandEmoji = BAND_EMOJI[data.band] || '⚪';
    const accStr    = data.achievedAcc != null ? `${data.achievedAcc}%` : '---';
    const gapStr    = data.gap != null
      ? (data.gap <= 0 ? `✅ +${Math.abs(data.gap)}pp` : `⚠️ -${data.gap}pp`)
      : '---';
    return `| **${market}** | ${bandEmoji} ${data.band} | ≥${data.minSignals} sinais | ${accStr} | ${data.target}% | ${gapStr} |`;
  }).join('\n');

  const content = `---
tipo: sniper-protocol
atualizado: ${t.iso}
mercados_na_meta: ${marketsOnTarget}
total_partidas: ${totalMatches}
precisao_global: ${overallAcc}
abstencao_rate: ${abstainRate}
tags:
  - sniper
  - treinamento
  - pie
  - precisao
---

# 🎯 Protocolo Sniper — "One Shot, One Kill"

> [!danger] Filosofia Militar
> Agentes só disparam quando o alvo está **100% confirmado**.
> Um GREEN preciso vale mais do que cinco sinais duvidosos.
> **Abstençao é disciplina, não fraqueza.**

> [!info] Última execução: ${t.display}
> **${totalMatches}** partidas analisadas · **${marketsOnTarget}/${Object.keys(thresholds).length}** mercados na meta

---

## 🔫 Thresholds por Mercado

| Mercado | Banda | Mínimo | Precisão Sniper | Meta | Status |
|---------|-------|--------|-----------------|------|--------|
${marketRows || '| — | — | — | — | — | *Sem dados* |'}

### Bandas de Confiança
| Banda | Sinais | Significado |
|-------|--------|-------------|
| 🔵 COLD | 1-2 | Alvo não confirmado — BLOQUEADO |
| 🟡 WARM | 3-4 | Em avaliação — depende do mercado |
| 🟢 HOT | 5-6 | Alvo confirmado — AUTORIZADO |
| 🔴 ELITE | 7+ | Alvo eliminado — disparo certeiro |

---

## 📊 Debriefing da Sessão

| Métrica | Valor |
|---------|-------|
| Total de partidas analisadas | **${totalMatches}** |
| Disparos autorizados | **${totalShots}** |
| ✅ Acertos (GREEN) | **${totalHits}** |
| ❌ Erros (RED) | **${totalShots - totalHits}** |
| 🎯 Precisão (disparos autorizados) | **${overallAcc}%** |
| ⏸️ Abstençoes (sinais insuficientes) | **${totalAbstained}** |
| 🛡️ Taxa de disciplina | **${abstainRate}%** dos jogos rejeitados |

---

## 📈 Evolução da Precisão

\`\`\`dataview
TABLE WITHOUT ID
  dateformat(date(atualizado), "dd/MM HH:mm") AS "Sessão",
  precisao_global + "%" AS "Precisão Global",
  mercados_na_meta AS "Mercados Meta",
  abstencao_rate + "%" AS "Disciplina"
FROM "Apostas Futebol"
WHERE tipo = "sniper-protocol"
SORT atualizado DESC
LIMIT 10
\`\`\`

---

## 🧠 Interpretação

> [!tip] Como usar estes dados
> - Mercados com banda **COLD/WARM** no threshold precisam de mais dados ou sinais mais fortes
> - Mercados **ELITE** já atingiram precisão máxima — manter exigência alta
> - A taxa de disciplina (${abstainRate}%) indica quantos jogos foram **sabiamente rejeitados**
> - Priorize mercados com gap ≤ 5pp para atingir a meta mais rápido

---

> *[[📊 Dashboard]] · [[🧠 Treinamento Noturno]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(filePath, content);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. TREINAMENTO NOTURNO — log de progresso do overnight trainer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Atualiza (ou cria) "🌙 Treinamento Noturno.md" com o progresso
 * de acurácia e os resultados do ciclo mais recente.
 *
 * @param {object} trainingData  { accuracy, sniperThr, resumo, duracao }
 */
export function updateTreinamentoNoturno(trainingData = {}) {
  if (!isObsidianConfigured()) return null;
  const t = _now();
  const filePath = join(_base(), '🌙 Treinamento Noturno.md');

  const { accuracy = {}, sniperThr = {}, resumo = {}, duracao = 0 } = trainingData;

  const MARKET_TARGETS = {
    'Over 1.5': 98, 'BTTS': 95, 'Over 2.5': 92,
    'Over Corners 6.5': 90, 'Over Corners 7.5': 85,
    'YC 2.5': 85, 'YC 3.5': 75, 'Over 3.5': 70,
  };

  // Tabela de progresso por mercado
  const marketRows = Object.entries(MARKET_TARGETS).map(([market, target]) => {
    const data    = accuracy[market];
    const sn      = sniperThr[market];
    if (!data) return `| **${market}** | — | ${target}% | — | ⏳ Sem dados |`;

    const acc     = data.acc;
    const gap     = data.gap;
    const bar     = buildProgressBar(acc, target);
    const status  = gap <= 0  ? '✅ META'
                  : gap <= 5  ? '🟡 Próximo'
                  : gap <= 15 ? '🟠 Progredindo'
                  :             '🔴 Distante';
    const snStr   = sn ? ` _(sniper: ${sn.band})_` : '';
    return `| **${market}** | ${bar} ${acc}% | ${target}% | ${gap > 0 ? '+' : ''}${gap}pp | ${status}${snStr} |`;
  }).join('\n');

  // Histórico de sessões via Dataview
  const content = `---
tipo: treinamento-noturno
atualizado: ${t.iso}
duracao_min: ${duracao}
mercados_prontos: ${resumo.prontos || 0}
mercados_progressao: ${resumo.emProgressão || 0}
mercados_distantes: ${resumo.longe || 0}
tags:
  - treinamento
  - pie
  - overnight
---

# 🌙 Treinamento Noturno — Log de Progresso

> [!info] Ciclo concluído em ${t.display}
> Duração: **${duracao} minutos** · Mercados na meta: **${resumo.prontos || 0}/${Object.keys(MARKET_TARGETS).length}**

---

## 📊 Status por Mercado

| Mercado | Progresso | Meta | Gap | Status |
|---------|-----------|------|-----|--------|
${marketRows}

---

## 🎯 Protocolo Sniper — Resumo

${Object.keys(sniperThr).length ? Object.entries(sniperThr).map(([m, d]) => {
  const icon = d.gap != null && d.gap <= 0 ? '✅' : '⚠️';
  return `- ${icon} **${m}** → banda **${d.band}** (≥${d.minSignals} sinais) → precisão: ${d.achievedAcc ?? '--'}%`;
}).join('\n') : '> *Execute o Protocolo Sniper para gerar esta seção.*'}

---

## 📈 Histórico de Sessões

\`\`\`dataview
TABLE WITHOUT ID
  dateformat(date(atualizado), "dd/MM HH:mm") AS "Sessão",
  mercados_prontos + "/" + (mercados_prontos + mercados_progressao + mercados_distantes) AS "Na Meta",
  duracao_min + " min" AS "Duração"
FROM "Apostas Futebol"
WHERE tipo = "treinamento-noturno"
SORT atualizado DESC
LIMIT 14
\`\`\`

---

## 🗓️ Rotina

| Horário | Fase |
|---------|------|
| 02:00 | 📥 Expansão histórica (+7 dias SofaScore) |
| 03:00 | 🧠 Deep Training 9 fases (padrões + calibração Poisson) |
| 04:00 | 🔄 Training Cycle semanal |
| 04:30 | 🎯 Protocolo Sniper — precisão por banda |
| 05:00 | 📋 Debriefing + sync Obsidian |

---

> *[[📊 Dashboard]] · [[🎯 Protocolo Sniper]] · [[🧠 Padrões Aprendidos]]*
`;

  return _write(filePath, content);
}

/** Barra de progresso ASCII para tabelas Obsidian */
function buildProgressBar(current, target) {
  const pct  = Math.min(100, Math.round((current / target) * 100));
  const fill = Math.round(pct / 10);
  return `\`${'█'.repeat(fill)}${'░'.repeat(10 - fill)}\``;
}

// ── Engajamento dos Membros ────────────────────────────────────────────────────

/**
 * Cria/atualiza a nota `📱 Engajamento dos Membros.md` com:
 *   — Visão geral de cliques, reações e taxa de engajamento
 *   — Top membros mais ativos
 *   — Sinais com maior conversão
 *   — Query Dataview para histórico automático
 *
 * @param {object} stats — resultado de getOverallStats() do engagement-tracker
 */
export function updateEngajamento(stats) {
  if (!isObsidianConfigured()) return null;
  const filePath = join(_dir(), '📱 Engajamento dos Membros.md');
  const t = _now();

  const topMembersTable = stats.topMembers.length
    ? stats.topMembers.map((m, i) => {
        const tag = m.username || m.firstName || `ID ${m.userId}`;
        const total = m.clicks + m.reactions;
        const bar   = buildProgressBar(total, Math.max(1, stats.topMembers[0].clicks + stats.topMembers[0].reactions));
        return `| ${i + 1} | **${tag}** | ${m.clicks} | ${m.reactions} | ${bar} |`;
      }).join('\n')
    : '| — | *Nenhum dado ainda* | — | — | — |';

  const topSignalsTable = stats.topSignals.length
    ? stats.topSignals.map(s => {
        const date = new Date(s.sentAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
        const hour = new Date(s.sentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `| **${(s.match || '?').substring(0, 30)}** | ${s.market || '—'} | ${s.clicks} | ${s.reactions} | ${date} ${hour} |`;
      }).join('\n')
    : '| — | — | — | — | — |';

  const rateBar = buildProgressBar(parseFloat(stats.clickRate), 100);

  const content = `---
tipo: engajamento
atualizado: ${t.iso}
periodo_dias: ${stats.period.replace('d', '')}
total_sinais: ${stats.totalSignals}
total_cliques: ${stats.totalClicks}
total_reacoes: ${stats.totalReactions}
taxa_clique: ${stats.clickRate}
tags:
  - engajamento
  - membros
  - telegram
---

# 📱 Engajamento dos Membros

> [!info] Atualizado em ${t.display} · Período: **últimos ${stats.period}**
> Rastreamento automático via bot — cliques no botão + reações a mensagens.

---

## 📊 Visão Geral

| Métrica | Valor |
|---------|-------|
| 📡 Sinais enviados | **${stats.totalSignals}** |
| 🔗 Cliques no link | **${stats.totalClicks}** |
| 💬 Reações | **${stats.totalReactions}** |
| 📈 Taxa de clique | **${stats.clickRate}%** |

**Taxa de conversão:** ${rateBar} ${stats.clickRate}%

> [!tip] Interpretação
> Taxa ≥ 30% = excelente engajamento · 15–30% = bom · < 15% = melhorar timing/qualidade dos sinais

---

## 🏆 Top Membros — Mais Engajados

| # | Membro | 🔗 Cliques | 💬 Reações | Atividade |
|---|--------|-----------|-----------|-----------|
${topMembersTable}

---

## 🔥 Sinais com Maior Conversão

| Partida | Mercado | 🔗 Cliques | 💬 Reações | Enviado |
|---------|---------|-----------|-----------|---------|
${topSignalsTable}

---

## 📈 Histórico de Engajamento

\`\`\`dataview
TABLE WITHOUT ID
  dateformat(date(atualizado), "dd/MM/yy") AS "Data",
  total_sinais AS "Sinais",
  total_cliques AS "Cliques",
  total_reacoes AS "Reações",
  taxa_clique + "%" AS "Taxa"
FROM "Apostas Futebol"
WHERE tipo = "engajamento"
SORT atualizado DESC
LIMIT 30
\`\`\`

---

## 💡 Glossário

| Termo | Definição |
|-------|-----------|
| **Clique** | Membro tocou no botão "Apostar agora → Superbet" |
| **Reação** | Membro reagiu com emoji à mensagem do sinal |
| **Taxa de clique** | Cliques ÷ Sinais × 100 |

> ⚠️ *Limitação do Telegram: não há read receipts em grupos. "Visualizado" não é mensurável — apenas ações ativas (clique + reação) são registradas.*

---

> *[[📊 Dashboard]] · [[🛡️ Guardian]] · [[📈 ROI e Performance]]*
`;

  return _write(filePath, content);
}
