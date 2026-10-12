<#
  ProBeing laptop watcher: set it up once. Paste the line that ProBeing
  Settings -> "Pair this laptop" shows; it runs this file with the three values.

  It checks ActivityWatch is running, runs the self test and one look at the
  server, and only then keeps the token, encrypted for your Windows account only
  (DPAPI), and adds a task that runs watch.ps1 every 5 minutes while you are
  signed in. A failed step leaves nothing behind.
  Then the tray dot (item 27): a task that starts tray.ps1 at sign-in, started
  once now. `install.ps1 -TrayOnly` adds just the dot to a laptop already paired.
  Re-running either replaces the tasks and restarts the dot; it never adds a second.
  Nothing is installed. uninstall.ps1 takes it all away again.
#>
[CmdletBinding(DefaultParameterSetName = 'Pair')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Pair')][string]$Url,
  [Parameter(Mandatory = $true, ParameterSetName = 'Pair')][string]$Key,
  [Parameter(Mandatory = $true, ParameterSetName = 'Pair')][string]$Token,
  [Parameter(ParameterSetName = 'Pair')][string]$AwUrl = 'http://localhost:5600',
  [Parameter(Mandatory = $true, ParameterSetName = 'Tray')][switch]$TrayOnly
)

$ErrorActionPreference = 'Stop'
$TaskName = 'ProBeing watcher'
$dir = Join-Path $env:LOCALAPPDATA 'ProBeing'
$watch = Join-Path $PSScriptRoot 'watch.ps1'
$TrayTask = 'ProBeing tray'
$tray = Join-Path $PSScriptRoot 'tray.ps1'

# A running dot is asked to go (it removes its icon) before the task is replaced, so a re-run restarts it.
function Stop-RunningTray {
  $evt = $null
  if ([System.Threading.EventWaitHandle]::TryOpenExisting('Local\ProBeingTrayQuit', [ref]$evt)) {
    [void]$evt.Set()
    for ($i = 0; $i -lt 20; $i++) {
      $m = $null
      if (-not [System.Threading.Mutex]::TryOpenExisting('Local\ProBeingTray', [ref]$m)) { break }
      $m.Dispose()
      Start-Sleep -Milliseconds 250
    }
    $evt.Dispose()
  }
  Stop-ScheduledTask -TaskName $TrayTask -ErrorAction SilentlyContinue
  # One that did not answer in 5 seconds is ended.
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*\tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# The dot at every sign-in, started once now. -Force replaces the task, never adds a second.
function Add-Tray {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tray -SelfTest
  if ($LASTEXITCODE -ne 0) { throw 'the tray self test failed (the lines above)' }
  Stop-RunningTray
  $trayArgs = '-NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "' + $tray + '"'
  $act = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $trayArgs)
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # No time limit: the default (3 days) would take the dot away.
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  $me = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TrayTask -Action $act -Trigger $atLogon -Settings $set -Principal $me -Force | Out-Null
  Start-ScheduledTask -TaskName $TrayTask
}

if ($PSCmdlet.ParameterSetName -eq 'Tray') {
  if (-not (Test-Path (Join-Path $dir 'watcher.json'))) {
    Write-Output 'This laptop is not paired yet. Paste the line from ProBeing Settings -> Pair this laptop first; it adds the dot too.'
    exit 1
  }
  Write-Output 'The dot by the clock: self test, then a task at every sign-in'
  try { Add-Tray } catch { Write-Output ('The dot was not added: ' + $_.Exception.Message); exit 1 }
  Write-Output 'Done. The dot is by the clock (it may sit under the ^ arrow: drag it out to keep it in view).'
  exit 0
}

Write-Output '1/6  Is ActivityWatch running?'
try { Invoke-RestMethod -Uri ($AwUrl + '/api/0/info') -TimeoutSec 10 | Out-Null }
catch { Write-Output 'ActivityWatch is not answering at http://localhost:5600. Start it, then run this line again.'; exit 1 }

Write-Output '2/6  Self test'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -SelfTest
if ($LASTEXITCODE -ne 0) { Write-Output 'The self test failed. Nothing was saved or scheduled. Send Claude the lines above.'; exit 1 }

# The token is tried from a scratch file first; watcher.json is written only once ProBeing accepted it.
Write-Output '3/6  One look at ProBeing (sends nothing)'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$trial = Join-Path $dir 'watcher.trial.json'
$secret = ConvertTo-SecureString $Token -AsPlainText -Force | ConvertFrom-SecureString
$conf = @{ url = $Url.TrimEnd('/'); key = $Key; token = $secret }
[System.IO.File]::WriteAllText($trial, (ConvertTo-Json $conf -Depth 3 -Compress), (New-Object System.Text.UTF8Encoding $false))
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $watch -Check -ConfigFile $trial
$checked = $LASTEXITCODE
if ($checked -ne 0) {
  Remove-Item $trial -ErrorAction SilentlyContinue
  Write-Output 'ProBeing did not accept the token. Nothing was saved. Pair again in Settings and use the new line.'
  exit 1
}

Write-Output '4/6  Keeping the token for this Windows account only'
Move-Item $trial (Join-Path $dir 'watcher.json') -Force

Write-Output '5/6  Every 5 minutes while you are signed in'
$argText = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watch + '"'
# conhost --headless keeps the window from flashing every 5 minutes (Windows 10 21H2 and later).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $argText)
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Repetition = $every.Repetition    # after a restart it repeats from sign-in too
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$who = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $logon) -Settings $settings -Principal $who -Force | Out-Null
} catch {
  Remove-Item (Join-Path $dir 'watcher.json') -ErrorAction SilentlyContinue
  Write-Output ('The task could not be added, so the saved token was removed again: ' + $_.Exception.Message)
  exit 1
}

# The watcher works without the dot, so a failure here undoes nothing above.
Write-Output '6/6  The dot by the clock, at every sign-in'
try { Add-Tray } catch { Write-Output ('The dot was not added (the watcher is fine): ' + $_.Exception.Message + '. Try again with install.ps1 -TrayOnly.') }

Write-Output ''
Write-Output 'Done. ProBeing now sees what you work on, only while you are working.'
Write-Output ('Log: ' + (Join-Path $dir 'watcher.log') + '   To stop: run uninstall.ps1')
