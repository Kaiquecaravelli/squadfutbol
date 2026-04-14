$TaskName  = "SquadfutbolPM2Startup"
$VbsPath   = "C:\Users\PCHOME01\Desktop\squadfutbol\scripts\pm2-startup.vbs"
$LogonUser = $env:USERNAME

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$Action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $VbsPath + '"')
$Trigger  = New-ScheduledTaskTrigger -AtLogOn -User $LogonUser
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -RunLevel Highest -Force

Write-Host "DONE: $TaskName registrado para logon de $LogonUser"
