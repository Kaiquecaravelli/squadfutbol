# ⚽ Betting Analysis Squad

Squad completo de análise de apostas esportivas com fluxo automático e multi-agente.

## Agentes

| Agente | Nome | Papel |
|--------|------|-------|
| `betting-master` | Apex | Orquestrador e decisão final |
| `scout` | Rex | Coleta de dados esportivos |
| `news-analyst` | Nora | Notícias e inteligência de imprensa |
| `tactician` | Vex | Análise tática e forma |
| `quant` | Sigma | Modelos probabilísticos e EV |
| `odds-tracker` | Pulse | Movimentos de odds e value bets |
| `risk-manager` | Shield | Kelly Criterion e gestão de banca |
| `reporter` | Echo | Relatórios e tracking de ROI |

## Fluxo de Análise

```
scout (dados) ──────────────────────────────────────────┐
                                                         ▼
news-analyst ──┐                               risk-manager → reporter → betting-master
tactician ─────┼──→ (análise paralela) ──────────────────┘      (decisão final)
quant ─────────┤
odds-tracker ──┘
```

## Workflows

- `full-match-analysis` — Análise completa de uma partida
- `daily-scan` — Varredura automática diária (08:00)
- `live-monitoring` — Monitoramento de odds ao vivo

## Plataforma Alvo
- **Superbet** (superbet.bet.br) — Grade de jogos, odds e mercados

## Setup Rápido

1. Copie `.env.example` para `.env` e preencha as chaves de API
2. Execute `npm install` (ou `pip install -r requirements.txt`)
3. Inicie com `@betting-master *analyze "Team A vs Team B"`
4. Para varredura diária: `@betting-master *daily-scan`

## APIs Necessárias

- **NewsAPI** — `newsapi.org` (notícias)
- **API-Football** — RapidAPI (dados esportivos)
- **OpenWeatherMap** — clima
- **OddsAPI** — comparação de odds

## Score de Confiança

| Score | Ação |
|-------|------|
| 80–100 | ✅ APOSTAR |
| 60–79 | ⚡ CONSIDERAR |
| 40–59 | ⚠️ AGUARDAR |
| 0–39 | ❌ IGNORAR |
