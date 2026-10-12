<#
  ProBeing laptop watcher: stop it. Removes the scheduled tasks and the saved
  token. Revoke the laptop in ProBeing Settings too, so the token is dead.
  uninstall.ps1 -TrayOnly removes just the tray dot and leaves the watcher.
#>
param([switch]$TrayOnly)

$ErrorActionPreference = 'Continue'

# Ask the dot to go (it removes its icon cleanly); one that does not answer in 5 seconds is ended.
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
Stop-ScheduledTask -TaskName 'ProBeing tray' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*\tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName 'ProBeing tray' -Confirm:$false -ErrorAction SilentlyContinue
if ($TrayOnly) {
  Write-Output 'The dot is gone and will not come back at sign-in. The watcher still runs.'
  exit 0
}

Unregister-ScheduledTask -TaskName 'ProBeing watcher' -Confirm:$false -ErrorAction SilentlyContinue
$dir = Join-Path $env:LOCALAPPDATA 'ProBeing'
foreach ($f in @('watcher.json', 'state.json')) {
  $p = Join-Path $dir $f
  if (Test-Path $p) { Remove-Item $p }
}
Write-Output 'Stopped. The tasks, the dot and the saved token are gone. Revoke this laptop in ProBeing Settings as well.'
