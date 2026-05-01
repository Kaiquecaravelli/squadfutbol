"""
deploy-auto.py — Aguarda SSH da VPS ficar acessível e faz deploy automático.
Execute: python deploy-auto.py
Deixe rodando em background. Quando a porta 22 abrir, faz tudo sozinho.
"""
import socket, time, paramiko, os, sys
from datetime import datetime

HOST     = '187.127.27.236'
USER     = 'root'
PASS     = 'Adm@02363000'
BASE_L   = r'C:\Users\PCHOME01\Desktop\squadfutbol'
BASE_R   = '/var/www/squadfutbol'

FILES = [
    ('src/workflows/auto-monitor.js', 'src/workflows/auto-monitor.js'),
    ('scripts/games-radar.js',        'scripts/games-radar.js'),
    ('scripts/pie-diagnostics.js',    'scripts/pie-diagnostics.js'),
]

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def porta_aberta():
    s = socket.socket()
    s.settimeout(5)
    r = s.connect_ex((HOST, 22))
    s.close()
    return r == 0

def deploy():
    log("Conectando via SSH...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=30)
    log("CONECTADO!")

    # Upload dos arquivos
    sftp = client.open_sftp()
    for local_rel, remote_rel in FILES:
        local  = os.path.join(BASE_L, local_rel)
        remote = BASE_R + '/' + remote_rel
        log(f"Enviando {local_rel}...")
        sftp.put(local, remote)
        log(f"  OK -> {remote}")
    sftp.close()

    # Backup + restart
    log("Reiniciando PM2...")
    cmds = [
        "pm2 restart squadfutbol",
        "pm2 list",
        "echo DEPLOY_CONCLUIDO",
    ]
    for cmd in cmds:
        _, out, err = client.exec_command(cmd)
        result = out.read().decode().strip()
        if result:
            log(result)

    # Notificação Telegram
    try:
        import urllib.request, json
        env_path = os.path.join(BASE_L, '.env')
        token, chat = '', ''
        with open(env_path) as f:
            for line in f:
                if line.startswith('TELEGRAM_BOT_TOKEN='): token = line.split('=',1)[1].strip()
                if line.startswith('TELEGRAM_GROUP_ID='): chat = line.split('=',1)[1].strip()
                if line.startswith('TELEGRAM_CHAT_ID=') and not chat: chat = line.split('=',1)[1].strip()
        if token and chat:
            msg = "✅ Deploy automático concluído!\n\n📡 /grade agora funciona com RADAR direto (sem FlashScore).\nBot reiniciado com sucesso."
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            data = json.dumps({"chat_id": chat, "text": msg}).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10)
            log("Notificação Telegram enviada!")
    except Exception as e:
        log(f"Telegram notify: {e}")

    client.close()
    log("=" * 50)
    log("DEPLOY COMPLETO! Bot atualizado e rodando.")
    log("=" * 50)

# ── Loop principal ─────────────────────────────────────────────────────────────
log("Monitor de deploy iniciado.")
log(f"Aguardando porta 22 em {HOST}...")
log("Abra o firewall em: hpanel.hostinger.com → VPS → Firewall → TCP 22")
log("-" * 50)

tentativa = 0
while True:
    tentativa += 1
    if porta_aberta():
        log(f"PORTA 22 ABERTA! (tentativa {tentativa})")
        try:
            deploy()
            sys.exit(0)
        except Exception as e:
            log(f"Erro no deploy: {e}")
            log("Tentando novamente em 30s...")
            time.sleep(30)
    else:
        if tentativa % 5 == 0:
            log(f"Porta 22 ainda fechada (tentativa {tentativa}). Aguardando...")
        time.sleep(20)
