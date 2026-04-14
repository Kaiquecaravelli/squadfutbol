# Task: generate-report
agent: reporter
elicit: false

## Inputs
- Todos os outputs das tasks anteriores

## Steps
1. Calcular confidence_score (0–100):
   - Quant (35%): EV × 200, capped em 35
   - Tactical (25%): edge present +20, risk_flags -5 cada
   - News (15%): 8 + (homeImpact - awayImpact) × 0.3
   - Odds movement (15%): sharp_money_home=15, neutral=8, against=3
   - Risk level (10%): LOW=10, MEDIUM=6, HIGH=2
2. Derivar recommendation: BET(≥80) | CONSIDER(≥60) | WAIT(≥40) | SKIP(<40)
3. Renderizar relatório em ASCII box (terminal)
4. Salvar relatório em `reports/{match}_{timestamp}.md`
5. Retornar { confidence_score, recommendation, top_bet, report_text }

## Output
```json
{
  "confidence_score": 82,
  "recommendation": { "label": "✅ APOSTAR", "action": "BET" },
  "top_bet": { "market", "odds", "house", "ev_pct" },
  "risk": { "stake", "stake_pct" },
  "report_text": "..."
}
```
