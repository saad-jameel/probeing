<#
  ProBeing laptop watcher: stop it. Removes the scheduled task and the saved
  token. Revoke the laptop in ProBeing Settings too, so the token is dead.
#>
$ErrorActionPreference = 'Continue'
Unregister-ScheduledTask -TaskName 'ProBeing watcher' -Confirm:$false -ErrorAction SilentlyContinue
$dir = Join-Path $env:LOCALAPPDATA 'ProBeing'
foreach ($f in @('watcher.json', 'state.json')) {
  $p = Join-Path $dir $f
  if (Test-Path $p) { Remove-Item $p }
}
Write-Output 'Stopped. The task and the saved token are gone. Revoke this laptop in ProBeing Settings as well.'
