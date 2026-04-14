' pm2-startup.vbs — Inicia o PM2 sem janela CMD visível
' Use este arquivo no Agendador de Tarefas no lugar do pm2-startup.bat
' Configurar: Programa = wscript.exe | Argumentos = "C:\Users\PCHOME01\Desktop\squadfutbol\scripts\pm2-startup.vbs"

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c """ & "C:\Users\PCHOME01\Desktop\squadfutbol\scripts\pm2-startup.bat" & """", 0, False
Set WshShell = Nothing
