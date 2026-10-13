<#
  ProBeing tray dot (item 27): a coloured dot by the clock. Green working,
  amber on a break, blue asleep, grey day over or not started; a red ring when
  it cannot reach ProBeing. Hover for "Working on: ..."; click to open ProBeing.

  Uses the laptop watcher's pairing (watcher.json, DPAPI) and asks
  activity-ingest {op: 'glance'} once a minute. It writes nothing to ProBeing.

  Item 30b: every ~10 s it notes which virtual desktop the window in front is on
  (Windows' IVirtualDesktopManager, the name from the registry) in desktops.json:
  [start, end, name] spans, names only, the last 48 hours. watch.ps1 reads it.

    tray.ps1             the dot (the "ProBeing tray" task runs it at sign-in)
    tray.ps1 -Check      one look, printed; no dot
    tray.ps1 -SelfTest   colours and tooltips from tray_selftest.json; nothing read or sent

  Windows PowerShell 5.1, nothing to install. Keep it plain ASCII.
#>
param(
  [string]$ConfigFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\watcher.json'),
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\tray.log'),
  [string]$Fixtures = (Join-Path $PSScriptRoot 'tray_selftest.json'),
  [string]$DesktopFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\desktops.json'),
  [switch]$Check,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$APP_URL = 'https://saad-jameel.github.io/probeing/'
$EVERY_MS = 60000
$RETRY_MS = 15000        # one quick retry before the red ring: a laptop just woken has no network yet
$MUTEX_NAME = 'Local\ProBeingTray'
$QUIT_NAME = 'Local\ProBeingTrayQuit'

# ------------------------------------------------------------ the view
# Twin of the JS in claudeWorkingDocs/tests/item27_tray.js; tray_selftest.json checks both.

$TRAY_TIP_MAX = 63       # NotifyIcon.Text throws past 63 characters on .NET Framework
$TRAY_LINE2_MIN = 40
$TRAY_COLOURS = @{ working = 'green'; break = 'amber'; asleep = 'blue'; off = 'grey' }
$TRAY_RGB = @{ green = '#2E9D4F'; amber = '#E0A020'; blue = '#3B6FD8'; grey = '#8A8A8A' }
$DOT = [string][char]0x00B7
$SEP = ' ' + $DOT + ' '
$ELLIPSIS = [string][char]0x2026

function Tray-Str($s) { if ($null -eq $s) { return '' } return [string]$s }

function Get-Field($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) { if ($obj.Contains($name)) { return $obj[$name] } return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Tray-OneLine($s) {
  $t = (Tray-Str $s) -creplace '[\u0000-\u001f\u007f]', ' '
  $t = $t -creplace ' {2,}', ' '
  return $t.Trim(' ')
}

function Tray-Cut([string]$s, [int]$n) {
  if ($s.Length -le $n) { return $s }
  if ($n -lt 2) { return '' }
  $t = $s.Substring(0, $n - 1)
  if ([char]::IsHighSurrogate($t[$t.Length - 1])) { $t = $t.Substring(0, $t.Length - 1) }
  return ($t -creplace '[ \u00b7]+$', '') + $ELLIPSIS
}

# "Mon 4h 20m . 3 M . 4/5 prayers . as of 5:42 PM" -> "4h 20m . 3 M . 4/5 prayers"
function Tray-Figures($body) {
  $out = New-Object System.Collections.Generic.List[string]
  $parts = (Tray-OneLine $body).Split([string[]]@($SEP), [System.StringSplitOptions]::None)
  for ($i = 0; $i -lt $parts.Length; $i++) {
    $p = $parts[$i].Trim(' ')
    if ($i -eq 0) { $p = $p -creplace '^[A-Z][a-z]{2} ', '' }
    if ($p -and -not ($p -cmatch '^as of ')) { $out.Add($p) }
  }
  return ($out.ToArray() -join $SEP)
}

# Case-sensitive, as the JS twin is (a PowerShell hashtable is not).
function Tray-Colour($state) {
  $s = Tray-Str $state
  foreach ($k in @('working', 'break', 'asleep', 'off')) { if ($s -ceq $k) { return $TRAY_COLOURS[$k] } }
  return ''
}

function Tray-Line1($r) {
  $title = Tray-OneLine (Get-Field $r 'title')
  $state = Tray-Str (Get-Field $r 'state')
  if ($state -ceq 'working') {
    # The glance row lags a press by seconds; the state word is the fresher of the two.
    if ($title.StartsWith('Working on: ', [System.StringComparison]::Ordinal)) { return ($title -creplace ($SEP + 'paused$'), '') }
    return 'Working'
  }
  if ($state -ceq 'break') { return 'On a break' }
  if ($state -ceq 'asleep') { return 'Asleep' }
  if ($state -ceq 'off') { if ($title -ceq 'Not started yet') { return $title } return 'Day over' }
  return 'ProBeing'
}

# Two lines in 63 characters: the figures keep at least 40, the first line gets the rest.
function Tray-Fit([string]$a, [string]$b) {
  if (-not $b) { return (Tray-Cut $a $TRAY_TIP_MAX) }
  $b = Tray-Cut $b ([Math]::Max($TRAY_LINE2_MIN, $TRAY_TIP_MAX - 1 - $a.Length))
  return (Tray-Cut $a ($TRAY_TIP_MAX - 1 - $b.Length)) + "`n" + $b
}

# $err: '' (a reply), 'offline' or 'unpaired'. $last: the newest good reply, for the red-ring tooltip.
function Tray-View($reply, [string]$err, $last) {
  if ($err -ceq 'unpaired') { return @{ colour = 'grey'; ring = $true; tip = 'ProBeing: this laptop is not paired' } }
  if ($err) {
    $lc = Tray-Colour (Get-Field $last 'state')
    if ($null -ne $last -and $lc) { return @{ colour = $lc; ring = $true; tip = (Tray-Fit "Can't reach ProBeing" ('Last: ' + (Tray-Line1 $last))) } }
    return @{ colour = 'grey'; ring = $true; tip = "Can't reach ProBeing" }
  }
  $c = Tray-Colour (Get-Field $reply 'state')
  if (-not $c) { $c = 'grey' }
  return @{ colour = $c; ring = $false; tip = (Tray-Fit (Tray-Line1 $reply) (Tray-Figures (Get-Field $reply 'body'))) }
}

# A dot drawn at runtime, so the folder needs no image files.
function New-DotIcon([string]$colour, [bool]$ring, [int]$size) {
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $pad = [int][Math]::Max(1, [Math]::Floor($size / 8))
    $w = [int][Math]::Max(2, [Math]::Floor($size / 6))
    if ($ring) { $pad = $w + 1 }
    $fill = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.ColorTranslator]::FromHtml($TRAY_RGB[$colour]))
    $g.FillEllipse($fill, $pad, $pad, $size - 2 * $pad - 1, $size - 2 * $pad - 1)
    $fill.Dispose()
    if ($ring) {
      $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(255, 214, 40, 40)), ([float]$w)
      $half = [float]($w / 2)
      $g.DrawEllipse($pen, $half, $half, [float]($size - $w - 1), [float]($size - $w - 1))
      $pen.Dispose()
    }
  } finally { $g.Dispose() }
  # The handle is not freed; Get-DotIcon keeps at most eight icons for the life of the dot.
  $h = $bmp.GetHicon()
  $bmp.Dispose()
  return [System.Drawing.Icon]::FromHandle($h)
}

# ------------------------------------------------------------ desktops (item 30b)
# Twin of the JS in claudeWorkingDocs/tests/item30b_tray.js; tray_selftest.json "desktops" checks both.

$DESK_EVERY_MS = 10000                 # a sample this often
$DESK_GAP_MS = 30000                   # samples this close are one stretch (a missed tick is not a gap)
$DESK_KEEP_MS = 48 * 3600000           # the file keeps this long
$DESK_MAX = 20000                      # ...and at most this many spans
$DESK_NAME_MAX = 80

# As activity.js actCleanDesktop: one line, no control characters.
function Desk-Clean($s) {
  $t = ((Tray-Str $s) -creplace '[\u0000-\u001f\u007f]', ' ') -creplace ' {2,}', ' '
  $t = $t.Trim(' ')
  if ($t.Length -gt $DESK_NAME_MAX) {
    $t = $t.Substring(0, $DESK_NAME_MAX)
    if ([char]::IsHighSurrogate($t[$t.Length - 1])) { $t = $t.Substring(0, $t.Length - 1) }
  }
  return $t.TrimEnd(' ')
}

# A desktop id to its name: the name he gave it, else "Desktop N" by its place in the list.
function Desk-Name([string]$id, $ids, $names) {
  if (-not $id) { return '' }
  $n = ''
  if ($null -ne $names -and $names.ContainsKey($id)) { $n = Desk-Clean $names[$id] }
  if ($n) { return $n }
  $list = @($ids)
  for ($i = 0; $i -lt $list.Length; $i++) { if ([string]$list[$i] -ceq $id) { return 'Desktop ' + ($i + 1) } }
  if ($list.Length -eq 0) { return 'Desktop 1' }
  return ''
}

# One sample: the last span grows, or a new one starts (where the last ended, when the tick was on time).
function Desk-Add($spans, [double]$now, [string]$name) {
  if (-not $name) { return }
  $tail = $null
  if ($spans.Count -gt 0) { $tail = $spans[$spans.Count - 1] }
  if ($null -ne $tail -and $now -lt [double]$tail[1]) { return }
  if ($null -ne $tail -and ($now - [double]$tail[1]) -le $DESK_GAP_MS) {
    if ([string]$tail[2] -ceq $name) { $tail[1] = $now; return }
    $spans.Add(@([double]$tail[1], $now, $name))
    return
  }
  $spans.Add(@($now, $now, $name))
}

function Desk-Prune($spans, [double]$now) {
  while ($spans.Count -gt 0 -and ([double]$spans[0][1] -lt $now - $DESK_KEEP_MS -or $spans.Count -gt $DESK_MAX)) { $spans.RemoveAt(0) }
}

function Desk-Quote([string]$s) {
  return '"' + ($s.Replace('\', '\\').Replace('"', '\"')) + '"'
}

# The file's text, written by hand so a lone span is never unrolled.
function Desk-Json($spans) {
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($x in $spans) {
    $parts.Add('[' + ([long][Math]::Floor([double]$x[0])).ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',' +
               ([long][Math]::Floor([double]$x[1])).ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',' +
               (Desk-Quote (Desk-Clean $x[2])) + ']')
  }
  return '{"v":1,"spans":[' + ($parts.ToArray() -join ',') + ']}'
}

# The file read back; a span that is not [number, number, name] is dropped.
function Desk-Load([string]$text) {
  $out = New-Object System.Collections.Generic.List[object]
  if (-not $text) { return ,$out }
  try { $d = ConvertFrom-Json -InputObject $text } catch { return ,$out }
  foreach ($x in @($d.spans)) {
    if ($null -eq $x -or @($x).Count -ne 3) { continue }
    $a = [double]::NaN
    $b = [double]::NaN
    try { $a = [double]$x[0]; $b = [double]$x[1] } catch { }
    $n = Desk-Clean $x[2]
    if ($n -and -not [double]::IsNaN($a) -and -not [double]::IsNaN($b) -and $b -ge $a) { $out.Add(@($a, $b, $n)) }
  }
  return ,$out
}

# ------------------------------------------------------------ self test

function Run-SelfTest {
  $fx = Get-Content -Raw -Encoding UTF8 $Fixtures | ConvertFrom-Json
  $ok = 0; $bad = 0
  if ($fx.max -eq $TRAY_TIP_MAX) { $ok++ } else { $bad++; Write-Output ('FAIL max ' + $fx.max) }
  foreach ($c in @($fx.cases)) {
    $v = Tray-View $c.reply (Tray-Str $c.error) $c.last
    $same = ($v.colour -ceq $c.want.colour) -and ($v.ring -eq $c.want.ring) -and ($v.tip -ceq $c.want.tip) -and
            ($v.tip.Length -le $TRAY_TIP_MAX)
    if ($same) { $ok++ } else { $bad++; Write-Output ('FAIL ' + $c.name + ' -> ' + $v.colour + ' ' + $v.ring + ' ' + (ConvertTo-Json $v.tip)) }
  }
  Add-Type -AssemblyName System.Drawing
  foreach ($col in @('green', 'amber', 'blue', 'grey')) {
    foreach ($ring in @($false, $true)) {
      foreach ($size in @(16, 32)) {
        try {
          $ic = New-DotIcon $col $ring $size
          if ($ic.Width -eq $size) { $ok++ } else { $bad++; Write-Output ('FAIL icon ' + $col + ' ' + $ring + ' ' + $size) }
          $ic.Dispose()
        } catch { $bad++; Write-Output ('FAIL icon ' + $col + ' ' + $ring + ' ' + $size + ': ' + $_.Exception.Message) }
      }
    }
  }
  # Item 30b: the desktop names and the sampler, as item30b_tray.js runs them.
  foreach ($c in @($fx.desktops.names)) {
    $nm = @{}
    if ($null -ne $c.names) { foreach ($p in $c.names.PSObject.Properties) { $nm[$p.Name] = [string]$p.Value } }
    $got = Desk-Name (Tray-Str $c.id) @($c.ids) $nm
    if ($got -ceq $c.want) { $ok++ } else { $bad++; Write-Output ('FAIL desktop name ' + $c.name + ' -> ' + $got) }
  }
  foreach ($c in @($fx.desktops.samples)) {
    $sp = Desk-Load (Tray-Str $c.file)
    foreach ($st in @($c.steps)) { Desk-Add $sp ([double]$st[0]) (Tray-Str $st[1]); Desk-Prune $sp ([double]$st[0]) }
    $txt = Desk-Json $sp
    if ($txt -ceq $c.want) { $ok++ } else { $bad++; Write-Output ('FAIL desktop sampler ' + $c.name + ' -> ' + $txt) }
  }
  Write-Output ('selftest: ' + $ok + ' ok, ' + $bad + ' failed')
  if ($bad) { exit 1 }
  exit 0
}

if ($SelfTest) { Run-SelfTest }

# ------------------------------------------------------------ talking to ProBeing

function Write-Log([string]$line) {
  try {
    $dir = Split-Path $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 200000) { Remove-Item $LogFile }
    Add-Content -Path $LogFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm') + ' ' + $line) -Encoding UTF8
  } catch { }
}

# The watcher's pairing, read fresh each time so a re-pair is picked up; $null when missing or unreadable.
function Read-Pairing {
  if (-not (Test-Path $ConfigFile)) { return $null }
  try {
    $conf = Get-Content -Raw -Encoding UTF8 $ConfigFile | ConvertFrom-Json
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString ([string]$conf.token))))
    return @{ url = ([string]$conf.url).TrimEnd('/'); key = [string]$conf.key; secret = $secret }
  } catch { return $null }
}

# Runs in its own runspace so the dot never freezes while it waits. Plain .NET (no cmdlets), so the
# reply is read as UTF-8 (5.1's Invoke-RestMethod guesses Latin-1 without a charset).
$FETCH = {
  param($url, $key, $secret)
  try {
    $req = [System.Net.WebRequest]::Create($url + '/functions/v1/activity-ingest')
    $req.Method = 'POST'
    $req.Timeout = 20000
    $req.ReadWriteTimeout = 20000
    $req.ContentType = 'application/json'
    $req.Headers.Add('Authorization', 'Bearer ' + $key)
    $req.Headers.Add('apikey', $key)
    $req.Headers.Add('x-device-token', $secret)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"op":"glance"}')
    $req.ContentLength = $bytes.Length
    $up = $req.GetRequestStream()
    $up.Write($bytes, 0, $bytes.Length)
    $up.Close()
    $resp = $null
    try { $resp = $req.GetResponse() } catch {
      $e = $_.Exception
      while ($null -ne $e -and -not ($e -is [System.Net.WebException])) { $e = $e.InnerException }
      if ($null -ne $e) { $resp = $e.Response }
    }
    if ($null -eq $resp) { return @{ status = 0; text = '' } }
    $code = [int]$resp.StatusCode
    $rd = [System.IO.StreamReader]::new($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text = $rd.ReadToEnd()
    $rd.Close()
    $resp.Close()
    return @{ status = $code; text = $text }
  } catch { return @{ status = 0; text = '' } }
}

# A status and body to a reply and an error kind.
function Read-Reply([int]$status, [string]$text) {
  if ($status -eq 401 -or $status -eq 403) { return @{ reply = $null; err = 'unpaired' } }
  if ($status -ne 200) { return @{ reply = $null; err = 'offline' } }
  $r = $null
  try { $r = $text | ConvertFrom-Json } catch { $r = $null }
  if ($null -eq $r -or (Get-Field $r 'ok') -ne $true) { return @{ reply = $null; err = 'offline' } }
  return @{ reply = $r; err = '' }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Item 30b: the window in front's virtual desktop, by Windows' documented IVirtualDesktopManager.
$DESK_CS = @'
using System;
using System.Runtime.InteropServices;
namespace ProBeingDesk {
  [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out int onCurrent);
    [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid desktopId);
    [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, ref Guid desktopId);
  }
  public static class Front {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static IVirtualDesktopManager m;
    public static string DesktopId() {
      if (m == null) m = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")));
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "";
      Guid g;
      if (m.GetWindowDesktopId(h, out g) != 0 || g == Guid.Empty) return "";
      return g.ToString();
    }
  }
}
'@

# The desktops' order and the names he gave them (Task View's rename), read fresh each sample.
function Desk-Registry {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops'
  $ids = New-Object System.Collections.Generic.List[string]
  $names = @{}
  $k = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  $raw = $null
  if ($null -ne $k) { $raw = $k.VirtualDesktopIDs }
  if ($raw -is [byte[]]) {
    for ($i = 0; $i + 16 -le $raw.Length; $i += 16) { $ids.Add(([Guid]::new([byte[]]$raw[$i..($i + 15)])).ToString()) }
  }
  foreach ($g in $ids) {
    $n = Get-ItemProperty -Path (Join-Path $key ('Desktops\{' + $g + '}')) -ErrorAction SilentlyContinue
    if ($null -ne $n -and $n.Name) { $names[$g] = [string]$n.Name }
  }
  return @{ ids = $ids.ToArray(); names = $names }
}

function Desk-Now {
  $reg = Desk-Registry
  return (Desk-Name ([ProBeingDesk.Front]::DesktopId()) $reg.ids $reg.names)
}

# Written beside the file, then swapped in, so watch.ps1 never reads half of it.
function Desk-Save($spans) {
  $dir = Split-Path $DesktopFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $tmp = $DesktopFile + '.tmp'
  [System.IO.File]::WriteAllText($tmp, (Desk-Json $spans), (New-Object System.Text.UTF8Encoding $false))
  if (Test-Path $DesktopFile) { [System.IO.File]::Replace($tmp, $DesktopFile, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $DesktopFile) }
}

if ($Check) {
  $p = Read-Pairing
  if ($null -eq $p) { Write-Output 'Not paired: run install.ps1 with the line from ProBeing Settings first.'; exit 2 }
  $res = & $FETCH $p.url $p.key $p.secret
  $got = Read-Reply ([int]$res.status) ([string]$res.text)
  $v = Tray-View $got.reply $got.err $null
  Write-Output ('Answer: ' + $res.status + '. Now: ' + (Tray-Str (Get-Field $got.reply 'state')) + '. Dot: ' + $v.colour +
                $(if ($v.ring) { ' with a red ring' } else { '' }) + '.')
  Write-Output ('Tooltip (' + $v.tip.Length + ' of 63):')
  Write-Output $v.tip
  try {
    Add-Type -TypeDefinition $DESK_CS
    Write-Output ('Desktop in front: ' + (Desk-Now) + ' (' + @((Desk-Registry).ids).Length + ' desktops)')
  } catch { Write-Output 'Desktop in front: unknown (the virtual desktop API did not answer)' }
  if ($got.err) { exit 1 }
  exit 0
}

# ------------------------------------------------------------ the dot

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# One dot per sign-in: a second copy (the task and a manual start) leaves at once.
$created = $false
$script:mutex = [System.Threading.Mutex]::new($true, $MUTEX_NAME, [ref]$created)
if (-not $created) { exit 0 }
# install.ps1 and uninstall.ps1 set this to ask the dot to go, so its icon is removed cleanly.
$script:quitEvt = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::ManualReset, $QUIT_NAME)
[void]$script:quitEvt.Reset()

$script:icons = @{}
$script:size = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
$script:last = $null
$script:fails = 0
$script:lastErr = 'start'
$script:job = $null
$script:openedAt = [DateTime]::MinValue
$script:rs = [runspacefactory]::CreateRunspace()
$script:rs.Open()
$script:deskAt = 0
$script:deskErr = $false
$script:deskSpans = New-Object System.Collections.Generic.List[object]
$script:deskOn = $true
try {
  Add-Type -TypeDefinition $DESK_CS
  if (Test-Path $DesktopFile) { $script:deskSpans = Desk-Load ([System.IO.File]::ReadAllText($DesktopFile)) }
} catch { $script:deskOn = $false; Write-Log 'desktops: off (no virtual desktop API here)' }

function Get-DotIcon([string]$colour, [bool]$ring) {
  $k = $colour + '|' + $ring
  if (-not $script:icons.ContainsKey($k)) { $script:icons[$k] = New-DotIcon $colour $ring $script:size }
  return $script:icons[$k]
}

function Set-Next([int]$ms) {
  $script:tick.Stop()
  $script:tick.Interval = $ms
  $script:tick.Start()
}

function Show-Result([int]$status, [string]$text, [bool]$unpaired) {
  $got = Read-Reply $status $text
  if ($unpaired) { $got = @{ reply = $null; err = 'unpaired' } }
  if ($got.err -eq 'offline') {
    $script:fails++
    if ($script:fails -lt 2) { Set-Next $RETRY_MS; return }
  } else { $script:fails = 0 }
  # Only changes are logged, with a status code: never a title, the URL or the token.
  if ($got.err -ne $script:lastErr) {
    if ($got.err) { Write-Log ($got.err + ' (status ' + $status + ')') } else { Write-Log 'reached ProBeing' }
    $script:lastErr = $got.err
  }
  if (-not $got.err) { $script:last = $got.reply }
  $v = Tray-View $got.reply $got.err $script:last
  $script:icon.Icon = Get-DotIcon $v.colour $v.ring
  $script:icon.Text = Tray-Cut $v.tip $TRAY_TIP_MAX
}

function Start-Fetch {
  if ($null -ne $script:job) { return }
  # The next look is set before anything can throw, so an error never leaves the 1-second first tick running.
  Set-Next $EVERY_MS
  $p = Read-Pairing
  if ($null -eq $p) { Show-Result 0 '' $true; return }
  $ps = [PowerShell]::Create()
  $ps.Runspace = $script:rs
  [void]$ps.AddScript($FETCH.ToString()).AddArgument($p.url).AddArgument($p.key).AddArgument($p.secret)
  $script:job = @{ ps = $ps; handle = $ps.BeginInvoke() }
}

function Poll-Fetch {
  if ($null -eq $script:job -or -not $script:job.handle.IsCompleted) { return }
  $done = $script:job
  $script:job = $null
  $res = $null
  try { $res = $done.ps.EndInvoke($done.handle) } catch { $res = $null }
  try { $done.ps.Dispose() } catch { }
  $status = 0; $text = ''
  if ($null -ne $res -and $res.Count -gt 0) {
    $r = $res[0]
    # .PSObject.BaseObject: on a hashtable, .BaseObject is a key lookup and gives $null.
    $r = $r.PSObject.BaseObject
    $status = [int](Get-Field $r 'status')
    $text = Tray-Str (Get-Field $r 'text')
  }
  Show-Result $status $text $false
}

# Item 30b: one desktop sample every DESK_EVERY_MS, from the poll timer. An error is logged once, by type.
function Desk-Tick {
  if (-not $script:deskOn) { return }
  $now = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($now - $script:deskAt -lt $DESK_EVERY_MS -and $now -ge $script:deskAt) { return }
  $script:deskAt = $now
  try {
    Desk-Add $script:deskSpans $now (Desk-Now)
    Desk-Prune $script:deskSpans $now
    Desk-Save $script:deskSpans
    if ($script:deskErr) { Write-Log 'desktops: sampling again'; $script:deskErr = $false }
  } catch {
    if (-not $script:deskErr) { Write-Log ('desktops: error ' + $_.Exception.GetType().Name); $script:deskErr = $true }
  }
}

# A double click is two clicks: one browser tab, not two.
function Open-ProBeing {
  if (((Get-Date) - $script:openedAt).TotalSeconds -lt 3) { return }
  $script:openedAt = Get-Date
  # The installed app (Chrome or Edge puts its shortcut in the Start menu); else the browser.
  $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $lnk = Get-ChildItem -Path $menu -Recurse -Filter 'ProBeing*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lnk) { Start-Process $lnk.FullName } else { Start-Process $APP_URL }
}

function Stop-Tray {
  $script:tick.Stop()
  $script:poll.Stop()
  $script:icon.Visible = $false
  $script:icon.Dispose()
  Write-Log 'stopped'
  $script:ctx.ExitThread()
}

# A handler that throws would show WinForms' error box; log the kind of error instead.
function Safely([scriptblock]$what) {
  try { & $what } catch { Write-Log ('error: ' + $_.Exception.GetType().Name) }
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$script:ctx = New-Object System.Windows.Forms.ApplicationContext
$script:icon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add('Open ProBeing')
$itemOpen.Add_Click({ Safely { Open-ProBeing } })
$itemRefresh = $menu.Items.Add('Refresh now')
$itemRefresh.Add_Click({ Safely { Start-Fetch } })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$itemQuit = $menu.Items.Add('Quit')
$itemQuit.Add_Click({ Safely { Stop-Tray } })
$script:icon.ContextMenuStrip = $menu
$script:icon.Add_MouseClick({
  param($src, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Safely { Open-ProBeing; Start-Fetch } }
})
$script:icon.Icon = Get-DotIcon 'grey' $false
$script:icon.Text = 'ProBeing: looking...'
$script:icon.Visible = $true

$script:tick = New-Object System.Windows.Forms.Timer
$script:tick.Interval = 1000
$script:tick.Add_Tick({ Safely { Start-Fetch } })
$script:poll = New-Object System.Windows.Forms.Timer
$script:poll.Interval = 500
$script:poll.Add_Tick({ Safely { Poll-Fetch }; Safely { Desk-Tick }; if ($script:quitEvt.WaitOne(0)) { Safely { Stop-Tray } } })
$script:tick.Start()
$script:poll.Start()
Write-Log 'started'

[System.Windows.Forms.Application]::Run($script:ctx)

try { $script:rs.Dispose() } catch { }
try { $script:mutex.ReleaseMutex() } catch { }
exit 0
