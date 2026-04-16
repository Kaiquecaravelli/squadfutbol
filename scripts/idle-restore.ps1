# idle-restore.ps1 — Restaurar configurações normais (usuário voltou)
#
# Reinicia os serviços parados pelo idle-mode.ps1
# e restaura prioridades de processo ao normal.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\idle-restore.ps1

param(
  [switch]$Silent
)

function Log($msg) {
  if (-not $Silent) { Write-Host "[RESTORE] $msg" -ForegroundColor Green }
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path "$PSScriptRoot\..\logs\idle-mode.log" -Value "[$timestamp] [RESTORE] $msg" -Encoding UTF8
}

Log "=== RESTAURANDO CONFIGURAÇÕES NORMAIS ==="

# ── 1. Reiniciar serviços parados ─────────────────────────────────────────────
$stoppedFile = "$PSScriptRoot\..\data\idle-stopped-services.json"
$toRestore = @("SysMain", "WSearch")   # mínimo sempre restaurado

if (Test-Path $stoppedFile) {
  try {
    $saved = Get-Content $stoppedFile -Raw | ConvertFrom-Json
    $toRestore = $saved
    Log "Lista de serviços a restaurar carregada do arquivo"
  } catch {
    Log "Arquivo de serviços não lido — usando lista padrão"
  }
}

foreach ($svcName in $toRestore) {
  try {
    $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Running') {
      Start-Service -Name $svcName -ErrorAction SilentlyContinue
      Log "  INICIADO: $svcName"
    }
  } catch { }
}

# Limpa arquivo temporário
if (Test-Path $stoppedFile) { Remove-Item $stoppedFile -Force }

# ── 2. Restaurar prioridade dos processos ─────────────────────────────────────
$processesToRestore = @(
  "SearchIndexer",
  "MsMpEng",
  "OneDrive",
  "explorer"
)

foreach ($pname in $processesToRestore) {
  try {
    Get-Process -Name $pname -ErrorAction SilentlyContinue | ForEach-Object {
      $_.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal
    }
  } catch { }
}
Log "Processos: prioridade restaurada para Normal"

# ── 3. Reativar Windows Defender ─────────────────────────────────────────────
try {
  Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction SilentlyContinue
  Log "Windows Defender: monitoramento em tempo real reativado"
} catch { Log "Windows Defender: não foi possível reativar (requer admin)" }

Log "=== SISTEMA RESTAURADO AO NORMAL ==="
