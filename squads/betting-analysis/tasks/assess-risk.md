# Task: assess-risk
agent: risk-manager
elicit: false

## Inputs
- `quant_analysis.json` (value_bets, ev, odds)
- `bankroll` (de USER_BANKROLL no .env)
- `daily_exposure` (apostas já feitas hoje)

## Steps
1. Verificar se há value_bet disponível (EV >= MIN_EV_THRESHOLD)
   - Se não: retornar recommendation=NO_BET
2. Calcular Kelly Criterion completo para o top value_bet:
   - b = odds - 1
   - f = (b × p - (1-p)) / b
3. Aplicar Kelly fracionário: f × KELLY_FRACTION (padrão 0.25)
4. Aplicar teto: min(kelly_stake, bankroll × MAX_STAKE_PCT)
5. Verificar exposição diária (não ultrapassar 10% da banca/dia)
6. Gerar warnings se necessário
7. Definir risk_level: LOW (EV>=12%) | MEDIUM (EV>=7%) | HIGH (EV<7%)

## Output
```json
{
  "recommendation": "PROCEED | CAUTION | NO_BET",
  "market", "house", "odds", "ev",
  "bankroll", "stake", "stake_pct",
  "kelly_full", "kelly_fractional",
  "risk_level", "warnings": []
}
```
