# idle-mode.ps1 — Modo Economia de Energia (usuário ausente)
#
# Ativa quando o usuário não está usando o computador.
# Para serviços desnecessários, reduz atividade de fundo.
# Os processos Node.js/PM2 CONTINUAM rodando normalmente.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\idle-mode.ps1
#   (ou chamado automaticamente pelo idle-controller.js)

param(
  [switch]$Silent   # Sem output no console (para chamada automática)
)

function Log($msg) {
  if (-not $Silent) { Write-Host "[IDLE] $msg" -ForegroundColor Cyan }
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path "$PSScriptRoot\..\logs\idle-mode.log" -Value "[$timestamp] $msg" -Encoding UTF8
}

Log "=== MODO ECONOMIA ATIVADO ==="

# ── 1. Desligar monitor imediatamente ─────────────────────────────────────────
# Envia mensagem WM_SYSCOMMAND SC_MONITORPOWER para desligar a tela
$code = @"
using System;
using System.Runtime.InteropServices;
public class MonitorHelper {
    [DllImport("user32.dll")]
    public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
    public static void TurnOff() { SendMessage(-1, 0x0112, 0xF170, 2); }
}
"@
try {
  Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue
  [MonitorHelper]::TurnOff()
  Log "Monitor desligado"
} catch { Log "Monitor: não foi possível desligar via API (normal se já estiver apagado)" }

# ── 2. Parar serviços não essenciais ──────────────────────────────────────────
$servicesToStop = @(
  @{ Name = "SysMain";         Display = "SysMain / Superfetch (pré-carregamento RAM)" },
  @{ Name = "WSearch";         Display = "Windows Search (indexação de disco)" },
  @{ Name = "DiagTrack";       Display = "Telemetria/diagnóstico Microsoft" },
  @{ Name = "XblGameSave";     Display = "Xbox Game Save" },
  @{ Name = "XboxNetApiSvc";   Display = "Xbox Network Service" },
  @{ Name = "XblAuthManager";  Display = "Xbox Auth Manager" },
  @{ Name = "Fax";             Display = "Serviço de Fax" },
  @{ Name = "MapsBroker";      Display = "Downloaded Maps Manager" },
  @{ Name = "RetailDemo";      Display = "Retail Demo Service" },
  @{ Name = "WbioSrvc";        Display = "Windows Biometric (impressão digital)" },
  @{ Name = "Spooler";         Display = "Print Spooler (impressora)" }
)

$stopped = @()
foreach ($svc in $servicesToStop) {
  try {
    $s = Get-Service -Name $svc.Name -ErrorAction SilentlyContinue
    if ($s -and $s.Status -eq 'Running') {
      Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
      $stopped += $svc.Name
      Log "  PARADO: $($svc.Display)"
    }
  } catch { }
}

# Salva lista de serviços parados para restaurar depois
$stopped | ConvertTo-Json | Set-Content -Path "$PSScriptRoot\..\data\idle-stopped-services.json" -Encoding UTF8

# ── 3. Reduzir prioridade de processos de fundo pesados ──────────────────────
$processesToLower = @(
  "SearchIndexer",   # indexador de arquivos
  "MsMpEng",        # Windows Defender (antivírus)
  "OneDrive",        # sincronização
  "Teams",           # Microsoft Teams
  "msedge",          # Microsoft Edge
  "chrome",          # Chrome (se aberto)
  "explorer"         # Windows Explorer (UI)
)

foreach ($pname in $processesToLower) {
  try {
    Get-Process -Name $pname -ErrorAction SilentlyContinue | ForEach-Object {
      $_.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Idle
    }
  } catch { }
}
Log "Processos de fundo: prioridade reduzida para Idle"

# ── 4. Suspender atualização do Windows Defender ─────────────────────────────
try {
  Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
  Log "Windows Defender: monitoramento em tempo real pausado temporariamente"
} catch { Log "Windows Defender: não foi possível pausar (requer admin)" }

# ── 5. Limpar memória de trabalho ─────────────────────────────────────────────
try {
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
  Log "GC .NET: memória de trabalho liberada"
} catch { }

# ── 6. Confirmar que PM2/Node está saudável ───────────────────────────────────
try {
  $pm2Status = & node -e "const { execSync } = require('child_process'); const out = execSync('pm2 jlist', { encoding: 'utf8' }); const procs = JSON.parse(out); const online = procs.filter(p => p.pm2_env?.status === 'online').map(p => p.name); console.log(online.join(', ') || 'nenhum');" 2>&1
  Log "PM2 processos online: $pm2Status"
} catch { Log "PM2: status não verificado" }

Log "=== MODO ECONOMIA ATIVO — Node.js/PM2 rodando normalmente ==="
Log "    Para restaurar: powershell -File scripts\idle-restore.ps1"
