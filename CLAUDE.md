# CLAUDE.md — Squadfutbol Project Brain

**Índice virtual do projeto.** Atualizado: 2026-04-12
**Regra:** máximo 200 linhas. Se crescer → split em `docs/CLAUDE-part2.md`.

## 🎯 Foco Atual
- **Pipeline Diário Automático** — coleta +24h → backfill → PIE → Telegram (`daily-pipeline.js`)
- **PIE (Performance Intelligence Engine)** — 10+ mercados calibrados com 100+ amostras reais
- **Diversificação** — `quant.js` agora gera value bets para 19 mercados (gols, escanteios, YC, 1X2)

## 📊 Status PIE (atualizado 2026-04-11)
| Mercado | Amostras | Precisão |
|---------|---------|----------|
| Over 1.5 | 212 | 92% ✅ |
| BTTS | 173 | 86% ✅ |
| Over 2.5 | 130 | 78% ✅ |
| Over 3.5 | 112 | 40% ✅ |
| Over Corners 6.5/7.5/8.5 | 112 | 78/69/62% ✅ |
| YC 2.5/3.5/4.5 | 112 | 73/54/38% ✅ |
| 1X | 44 | 80% 🟡 |
| X2 | 32 | 53% 🟡 |

## 🗓️ Rotina Diária Automática (daily-pipeline.js)
```
08:00 → Coleta SofaScore (ontem + anteontem)
      → Backfill: predições pendentes → resultado real → PIE
      → Injeção: padrões das partidas → calibração PIE
      → Gate de Qualidade: PIE≥70% + EV≥8% + Confiança≥75
      → Telegram: apenas oportunidades que passaram no gate
      → Relatório PIE: taxa global + acurácia por mercado
13:00 → Pipeline extra (partidas da manhã)
21:00 dom → Relatório semanal PIE
```

## ⚡ Comandos Rápidos
| Comando | Ação |
|---------|------|
| `npm run daily` | Pipeline completo agora |
| `npm run daily-dry` | Preview sem salvar |
| `npm run scheduler` | Agendador automático (08h/13h/dom) |
| `npm run backfill` | Fecha loop de feedback (resultados pendentes) |
| `npm run pie-diag` | Diagnóstico completo com metas |
| `npm run collect-auto` | Coleta SofaScore + injeta PIE |
| `npm run train-week` | Treina últimos 7 dias |
| `npm run sb-cache` | Testa cache PRÉ-LIVE Superbet |
| `npm run sb-cache-live` | Testa cache AO VIVO Superbet |

## 🧠 Arquivos Principais
- `src/scrapers/superbet-cache.js` — cache de URLs diretas Superbet (TTL 20min/5min)
- `scripts/daily-pipeline.js` — orquestrador da rotina diária
- `scripts/scheduler.js` — cron automático (08h/13h/dom 21h)
- `scripts/result-backfill.js` — fecha loop de feedback via SofaScore
- `scripts/pie-diagnostics.js` — relatório de saúde do PIE
- `src/agents/quant.js` — Poisson + Dixon-Coles + 19 mercados
- `src/pie/pie-storage.js` — persistência (saveResult/loadDB)
- `data/pie.json` — DB evolutivo (calibração, lições, padrões)

## 📦 Pipeline PIE (atual)
```
SofaScore API → sofascore-collector.js → data/daily-matches/YYYY-MM-DD.json
  → daily-pie-update.js → analyzeMatch() → {positives, lessons, calibration}
  → batchSaveAnalysis() → pie.json (calibração + lições + padrões)
  → result-backfill.js  → saveResult() → calibração atualizada com acertos reais
```

## 🎯 Gates de Qualidade (Telegram)
- PIE calibração ≥ 70% (com ≥ 30 amostras)
- EV esperado ≥ 8%
- Odds no sweet spot do mercado
- Confiança do modelo ≥ 75
- **URL Superbet direta obrigatória** — sem link = análise bloqueada (ETAPA 4.5)

## 🛡️ Protocolos Ativos
- **Token Economy:** zero filler, markdown hierarchy, ≤200 linhas/doc
- **Plan Mode:** `<thinking>` antes de tarefas complexas
- **MCP:** só ativar se dado externo obrigatório

## 📌 Próximos Passos
1. Iniciar `npm run scheduler` para coleta automática diária
2. Coletar 1X2 (Home Win / Away Win) para completar calibração faltante
3. Quando Over 1.5 atingir 95%+ real → ativar Kelly 0.30 nesse mercado
