# Task: full-analysis
agent: betting-master
elicit: false

## Descrição
Task orquestradora que executa o pipeline completo em sequência/paralelo.

## Execution Order
1. `collect-data` (blocking)
2. Em paralelo: `fetch-news` + `analyze-tactical` + `analyze-quantitative` + `track-odds`
3. `assess-risk` (depende de quant + odds)
4. `generate-report` (depende de todos)

## Decision Logic
```
confidence_score = weighted_sum(quant, tactical, news, odds, risk)
if score >= 80 → BET
if score >= 60 → CONSIDER
if score >= 40 → WAIT
else           → SKIP
```

## Notificações
- BET ou CONSIDER → enviar alerta Telegram (se configurado)
- Steam move detectado → alerta imediato independente do score
