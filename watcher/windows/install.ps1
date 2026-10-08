<#
  ProBeing laptop watcher: set it up once. Paste the line that ProBeing
  Settings -> "Pair this laptop" shows; it runs this file with the three values.

  It checks ActivityWatch is running, keeps the token encrypted for your
  Windows account only (DPAPI), runs the self test and one look at the server,
  then adds a task that runs watch.ps1 every 5 minutes while you are signed in.
  Nothing is installed. uninstall.ps1 takes it all away again.
#>
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Key,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$AwUrl = 'http://localhost:5600'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ProBeing watcher'
$dir = Join-Path $env:LOCALAPPDATA 'ProBeing'
$watch = Join-Path $PSScriptRoot 'watch.ps1'

Write-Output '1/5  Is ActivityWatch running?'
try { Invoke-RestMethod -Uri ($AwUrl + '/api/0/info') -TimeoutSec 10 | Out-Null }
catch { Write-Output 'ActivityWatch is not answering at http://localhost:5600. Start it, then run this line again.'; exit 1 }

Write-Output '2/5  Keeping the token for this Windows account only'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$secret = ConvertTo-SecureString $Token -AsPlainText -Force | ConvertFrom-SecureString
$conf = @{ url = $Url.TrimEnd('/'); key = $Key; token = $secret }
[System.IO.File]::WriteAllText((Join-Path $dir 'watcher.json'), (ConvertTo-Json $conf -Depth 3 -Compress),
                               (New-Object System.Text.UTF8Encoding $false))

Write-Output '3/5  Self test'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -SelfTest
if ($LASTEXITCODE -ne 0) { Write-Output 'The self test failed. Nothing was scheduled. Send Claude the lines above.'; exit 1 }

Write-Output '4/5  One look at ProBeing (sends nothing)'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -Check
if ($LASTEXITCODE -ne 0) { Write-Output 'ProBeing did not accept the token. Pair again in Settings and use the new line.'; exit 1 }

Write-Output '5/5  Every 5 minutes while you are signed in'
$argText = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watch + '"'
# conhost --headless keeps the window from flashing every 5 minutes (Windows 10 21H2 and later).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $argText)
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Repetition = $every.Repetition    # after a restart it repeats from sign-in too
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$who = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $logon) -Settings $settings -Principal $who -Force | Out-Null

Write-Output ''
Write-Output 'Done. ProBeing now sees what you work on, only while you are working.'
Write-Output ('Log: ' + (Join-Path $dir 'watcher.log') + '   To stop: run uninstall.ps1')
