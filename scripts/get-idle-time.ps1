# get-idle-time.ps1 — Retorna o tempo de inatividade do usuário em ms
# Uso: powershell -File get-idle-time.ps1  → imprime um número inteiro (ms)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}

public class IdleTime {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static uint GetIdleMs() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(info);
        GetLastInputInfo(ref info);
        return (uint)Environment.TickCount - info.dwTime;
    }
}
"@ -Language CSharp 2>$null

Write-Output ([IdleTime]::GetIdleMs())
