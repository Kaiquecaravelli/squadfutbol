# 🚀 Guia de Setup — Betting Analysis Squad
## Passo a passo para rodar no automático

---

## ✅ PASSO 1 — Instalar o Node.js (se não tiver)

Baixe em: https://nodejs.org  
Escolha a versão **LTS**. Instale e reinicie o terminal.

Verifique:
```bash
node --version   # deve mostrar v18.x ou superior
npm --version
```

---

## ✅ PASSO 2 — Instalar as dependências do projeto

Abra o terminal na pasta do projeto:
```bash
cd Desktop/squadfutbol
npm install
```
Isso instala: Playwright, axios, chalk, sqlite3, node-cron, etc.

---

## ✅ PASSO 3 — Instalar o browser (Chromium)

O sistema usa um browser invisível para acessar os sites.  
Execute **apenas uma vez**:
```bash
npx playwright install chromium
```
> Baixa ~150MB. Pode demorar alguns minutos.

---

## ✅ PASSO 4 — Criar o Bot do Telegram

### 4.1 — Criar o Bot
1. Abra o **Telegram** no celular ou computador
2. Pesquise: **@BotFather**
3. Clique em **START** e depois envie: `/newbot`
4. Digite um nome para o bot: ex. `Meu Análise Futebol`
5. Digite um username: ex. `meu_futebol_bot` *(deve terminar em `bot`)*
6. O BotFather vai te enviar um **TOKEN** — anote ele!

Exemplo de token: `7234567890:AAHdqTcvCH1vGWJxfSeofSs4tDXtoYp3jc8`

### 4.2 — Obter seu Chat ID
1. Pesquise no Telegram: **@userinfobot**
2. Clique START
3. O bot vai te responder com seu **Id** — anote ele!

Exemplo: `123456789`

### 4.3 — Testar se está funcionando
Cole esta URL no navegador (substitua pelos seus dados):
```
https://api.telegram.org/botSEU_TOKEN/sendMessage?chat_id=SEU_CHAT_ID&text=Funcionou!
```
Se aparecer `{"ok":true}` — está funcionando! ✅

---

## ✅ PASSO 5 — Configurar o arquivo .env

No terminal, dentro da pasta do projeto:
```bash
cp .env.example .env
```

Abra o arquivo `.env` com qualquer editor de texto (Notepad, VS Code, etc.)  
e preencha **no mínimo** estas 3 linhas:

```env
TELEGRAM_BOT_TOKEN=7234567890:AAHdqTcvCH1vGWJxfSeofSs4tDXtoYp3jc8
TELEGRAM_CHAT_ID=123456789
USER_BANKROLL=1000
```

**Configurações adicionais (opcionais mas recomendadas):**
```env
SCAN_INTERVAL_MINUTES=60    # verificar a cada 60 minutos
HOURS_AHEAD=8               # buscar jogos das próximas 8 horas
MIN_CONFIDENCE_SCORE=65     # notificar apenas se score >= 65
MAX_MATCHES_PER_SCAN=10     # analisar no máximo 10 jogos por ciclo
```

---

## ✅ PASSO 6 — Testar sem internet (modo demo)

Antes de rodar com dados reais, teste se tudo está funcionando:
```bash
node src/index.js demo
```

O que vai acontecer:
- 3 partidas simuladas serão analisadas (Man City, Real Madrid, Flamengo)
- Relatórios aparecem no terminal
- Se o Telegram estiver configurado, você recebe uma mensagem de teste

---

## ✅ PASSO 7 — Primeira execução real

```bash
node src/index.js auto
```

O que acontece automaticamente:
```
1. 🌐 FlashScore   → lista partidas das próximas 8h
2. 🤖 SofaScore    → coleta xG, ratings, H2H avançado
3. 📊 Academia     → estatísticas BTTS, Over/Under histórico  
4. 📊 365scores    → confirmação de dados e previsões
5. 🔗 Agregador    → cruza e valida dados das 4 fontes
6. 📊 Quant        → Poisson + Dixon-Coles + Scoring v5.4
7. ♟️  Tático       → forma, H2H, contexto
8. 📰 Notícias     → impacto de lesões/suspensões (se NewsAPI configurada)
9. 🛡️  Risco        → Kelly Criterion, stake ideal
10. 📱 Telegram    → notificação se score >= 65
11. ⏳ Aguarda      → próximo scan em 60 minutos
```

---

## ✅ PASSO 8 — Deixar rodando 24/7

### Opção A: Terminal aberto (mais simples)
Deixe o terminal aberto com o auto rodando. Funciona enquanto o PC ligar.

### Opção B: PM2 (recomendado — reinicia automaticamente)

Instalar o PM2:
```bash
npm install -g pm2
```

Iniciar o bot com PM2:
```bash
pm2 start "node src/index.js auto" --name betting-squad
pm2 save
pm2 startup
```

Comandos úteis do PM2:
```bash
pm2 status              # ver se está rodando
pm2 logs betting-squad  # ver logs em tempo real
pm2 restart betting-squad
pm2 stop betting-squad
```

---

## 📱 Exemplo de notificação que você vai receber no Telegram

```
🟢 OPORTUNIDADE DETECTADA 🟢

⚽ Flamengo vs Palmeiras
🏆 Brasileirão Série A
⏰ Horário do jogo: 21:30

🎯 MELHOR MERCADO
📌 BTTS (Ambas Marcam)
💰 Odds: 1.92 (bet365)
📈 Edge (EV): 8.4%

🔒 Confiança: 74/100
💵 Stake sugerida: R$ 22.50 (2.25% da banca)
📊 Score v5.4: 6.84 vs 5.21 (MODERADO)

📖 Ambas Marcam: os dois times precisam marcar ao menos 1 gol.

🔗 Fontes: flashscore · sofascore · academia
📋 Dados: 89% completos

🔗 Ver no FlashScore
```

---

## 📊 Fontes de Dados Utilizadas

| Site | O que fornece | Prioridade |
|------|--------------|-----------|
| **FlashScore** | H2H, forma, horário dos jogos | Base |
| **SofaScore** | xG, ratings, stats avançadas | Alta |
| **Academia das Apostas** | BTTS%, Over/Under histórico | Alta (futebol BR) |
| **365scores** | Confirmação de stats, previsões | Validação |

---

## 🔧 Comandos disponíveis

```bash
node src/index.js auto          # 🤖 MODO AUTOMÁTICO COMPLETO
node src/index.js demo          # 🎮 Teste sem internet
node src/index.js roi           # 📈 Ver ROI acumulado
node src/index.js history       # 📋 Histórico de análises
node src/index.js daily-scan    # Varredura manual do dia
node src/index.js analyze <id>  # Analisar uma partida específica
```

---

## ❓ Problemas comuns

**"Erro: Cannot find module"**  
→ Execute `npm install` novamente

**"Playwright: browser not found"**  
→ Execute `npx playwright install chromium`

**"Telegram não recebe mensagem"**  
→ Verifique se o TOKEN e CHAT_ID no `.env` estão corretos  
→ Teste a URL manualmente no navegador (Passo 4.3)

**"0 partidas encontradas"**  
→ Normal em horários sem jogos (madrugada)  
→ Configure `HOURS_AHEAD=24` para buscar jogos de amanhã também
