<#
  ProBeing laptop watcher (Stage 18b). Task Scheduler runs it every 5 minutes.

  Reads ActivityWatch on this laptop (http://localhost:5600), keeps only the
  minutes you were working (ProBeing says when), and sends TIME BLOCKS to
  ProBeing: start, end, app, site name, project, category. Never a URL, never
  page text. A window title leaves this laptop only for a block no rule could
  place, to let Gemini name its project; private ones never leave at all.

  The logic is a line-by-line copy of the sender half of
  supabase/functions/_shared/activity.js: change one, change the other.
  selftest.json is shared with the node tests, so `-SelfTest` checks the copy.

  Windows PowerShell 5.1, nothing to install.
    watch.ps1              one run (what the scheduled task does)
    watch.ps1 -Check       one run that sends no blocks and says what it saw
    watch.ps1 -SelfTest    the shared checks, nothing read or sent
#>
param(
  [string]$ConfigFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\watcher.json'),
  [string]$StateFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\state.json'),
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'ProBeing\watcher.log'),
  [string]$AwUrl = 'http://localhost:5600',
  [string]$Fixtures = (Join-Path $PSScriptRoot 'selftest.json'),
  [switch]$Check,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------ the shared logic

$ACT_DEFAULT_LISTS = @{
  distract = @('youtube.com/shorts', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com')
  private  = @('bank', 'password', 'bitwarden', '1password', 'lastpass', 'keepass', 'whatsapp', 'messenger',
               'signal', 'telegram')
  meeting  = @('meet.google.com', 'zoom.us', 'zoom', 'teams.microsoft.com', 'teams', 'discord')
}
$ACT_MIN_BLOCK_MS = 60000
$ACT_JOIN_GAP_MS = 60000
$ACT_TITLE_MAX = 120
$ACT_APP_MAX = 80
$ACT_PROJECT_MAX = 120
$ACT_KEY_MIN = 4
$ACT_KEY_MAX = 40
$ACT_LIST_MAX = 50
$ACT_ENTRY_MAX = 80
$ACT_BROWSERS = @('chrome', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi')

# Arrays come back whole (the comma), never unrolled to one item or to nothing.
function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  $v = $null
  if ($obj -is [System.Collections.IDictionary]) { if ($obj.Contains($name)) { $v = $obj[$name] } }
  else { $p = $obj.PSObject.Properties[$name]; if ($null -ne $p) { $v = $p.Value } }
  if ($v -is [System.Array]) { return ,$v }
  return $v
}

# A list to loop over. @($x) on a List[object] throws in 5.1 ("Argument types do not match").
function As-Seq($x) {
  if ($null -eq $x) { return ,@() }
  if ($x -is [System.Collections.IEnumerable] -and -not ($x -is [string]) -and -not ($x -is [System.Collections.IDictionary])) { return ,$x }
  return ,@($x)
}

function Act-Str($s) { if ($null -eq $s) { return '' } return [string]$s }

function Act-Norm($s) {
  return (Act-Str $s).ToLowerInvariant() -creplace '[^0-9a-z\u0080-\uffff]+', ''
}

function Act-Cut($s, [int]$max) {
  $t = Act-Str $s
  if ($t.Length -le $max) { return $t }
  $t = $t.Substring(0, $max)
  if ($t.Length -gt 0 -and [char]::IsHighSurrogate($t[$t.Length - 1])) { $t = $t.Substring(0, $t.Length - 1) }
  return $t
}

function Act-CleanApp($a) {
  $parts = (Act-Str $a) -split '[\\/]'
  $last = $parts[$parts.Length - 1]
  return Act-Cut (($last -creplace '[\u0000-\u001f]', '').Trim()) $ACT_APP_MAX
}

function Act-CleanDomain($d) {
  $h = (Act-Str $d).Trim().ToLowerInvariant() -creplace '^www\.', ''
  $h = $h -creplace '\.$', ''
  if ($h -cmatch '^[a-z0-9.-]{1,253}$') { return $h }
  return ''
}

function Act-UrlParts($url) {
  $m = [regex]::Match((Act-Str $url).Trim(), '^([a-z][a-z0-9+.-]*)://(?:[^/?#@]*@)?([^/?#:]*)(?::\d+)?([^?#]*)',
                      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $m.Success -or -not ($m.Groups[1].Value -match '^https?$')) { return @{ host = ''; path = '' } }
  $h = Act-CleanDomain $m.Groups[2].Value
  if (-not $h) { return @{ host = ''; path = '' } }
  $p = $m.Groups[3].Value.ToLowerInvariant()
  if (-not $p) { $p = '/' }
  return @{ host = $h; path = $p }
}

function Act-ScrubTitle($t) {
  $s = Act-Str $t
  $s = $s -replace '[a-z][a-z0-9+.-]*://\S+', ' '
  $s = $s -creplace '\S*[\\/]\S*', ' '
  $s = $s -creplace '\S*@\S*', ' '
  $s = $s -replace $ACT_BARE_DOMAIN, ' '
  $s = $s -creplace '[0-9](?:[ .\-]?[0-9]){5,}', ' '
  $s = $s -creplace '\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{12,}\b', ' '
  $s = $s -creplace '[\u0000-\u001f]', ' '
  $s = ($s -creplace '[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ').Trim(' ')
  return Act-Cut $s $ACT_TITLE_MAX
}

# A site named without http (docs.google.com).
$ACT_BARE_DOMAIN = '\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|co|pk|gov|edu|me|ai|info|biz|uk|us|in|xyz|site|online|tech|cloud)\b'

# Apps whose titles are paths or commands: never sent to Gemini.
$ACT_NO_TITLE_APPS = @('windowsterminal', 'cmd', 'powershell', 'pwsh', 'powershellise', 'explorer', 'conhost', 'wt',
                       'mintty', 'bash', 'wsl', 'ubuntu', 'terminal', 'alacritty', 'putty', 'kitty', 'gitbash', 'wezterm')

function Act-TitleSendable($app, $title) {
  if ($ACT_NO_TITLE_APPS -contains (Act-Norm ((Act-Str $app) -replace '\.exe$', ''))) { return $false }
  $raw = Act-Str $title
  if ($raw -cmatch '[A-Za-z]:\\|~/|(^|\s)/[A-Za-z]|\\\\|@[A-Za-z0-9_.-]+:') { return $false }
  return ((Act-ScrubTitle $raw) -cmatch '[A-Za-z\u0080-\uffff]{3}')
}

# A browser's own private window, said in its title.
$ACT_PRIVATE_TITLE = 'incognito|inprivate|private browsing'

function Act-IsBrowser($app) {
  $n = Act-Norm ((Act-Str $app) -replace '\.exe$', '')
  return ($ACT_BROWSERS -contains $n)
}

function Act-TidyList($list) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($x in (As-Seq $list)) {
    if ($null -eq $x) { continue }
    $e = Act-Cut ((Act-Str $x).Trim().ToLowerInvariant()) $ACT_ENTRY_MAX
    if ($e -and -not $out.Contains($e) -and $out.Count -lt $ACT_LIST_MAX) { $out.Add($e) }
  }
  return ,$out.ToArray()
}

function Act-Lists($l) {
  $out = @{}
  foreach ($k in @('distract', 'private', 'meeting')) {
    $v = Get-Prop $l $k
    if ($null -ne $v -and ($v -is [System.Array] -or $v -is [System.Collections.IList])) { $out[$k] = Act-TidyList $v }
    else { $out[$k] = $ACT_DEFAULT_LISTS[$k] }
  }
  return $out
}

function Act-EntryHits($entry, $seg, [bool]$withTitle) {
  $e = (Act-Str $entry).Trim().ToLowerInvariant()
  if (-not $e) { return $false }
  if ($e -cmatch '[./]') {
    $slash = $e.IndexOf('/')
    if ($slash -eq -1) { $h = $e; $path = '' } else { $h = $e.Substring(0, $slash); $path = $e.Substring($slash) }
    $h = $h -creplace '^www\.', ''
    $sh = Act-Str (Get-Prop $seg 'host')
    # A private site (mybank.com) also counts when only the title names it.
    if ($withTitle -and $h -and (Act-Str (Get-Prop $seg 'title')).ToLowerInvariant().Contains($h)) { return $true }
    # A browser window the extension did not see: the site's name in its title.
    if (-not $sh -and $h -and (Act-IsBrowser (Get-Prop $seg 'app'))) { return (Act-TitleNamesSite $h $path (Get-Prop $seg 'title')) }
    if (-not $sh -or -not $h) { return $false }
    if ($sh -cne $h -and -not $sh.EndsWith('.' + $h, [System.StringComparison]::Ordinal)) { return $false }
    if (-not $path) { return $true }
    return (Act-Str (Get-Prop $seg 'path')).StartsWith($path, [System.StringComparison]::Ordinal)
  }
  $w = Act-Norm $e
  if ($w.Length -lt 3) { return $false }
  if ((Act-Norm (Get-Prop $seg 'app')).Contains($w)) { return $true }
  if ((Act-Norm (Get-Prop $seg 'host')).Contains($w)) { return $true }
  return ($withTitle -and (Act-Norm (Get-Prop $seg 'title')).Contains($w))
}

function Act-TitleNamesSite($h, $path, $title) {
  $t = (Act-Str $title).ToLowerInvariant()
  $label = ([string]$h).Split('.')[0]
  if ($label.Length -lt 3 -or -not ($t -cmatch ('(^|[^a-z0-9])' + $label + '([^a-z0-9]|$)'))) { return $false }
  $parts = ([string]$path).Split('/')
  $part = ''
  if ($parts.Length -gt 1) { $part = $parts[1] }
  if (-not $part) { return $true }
  return (($part -cmatch '^[a-z0-9-]{3,}$') -and ($t -cmatch ('(^|[^a-z0-9])' + $part + '([^a-z0-9]|$)')))
}

function Act-ListHit($list, $seg, [bool]$withTitle) {
  foreach ($e in (As-Seq $list)) { if (Act-EntryHits $e $seg $withTitle) { return $e } }
  return ''
}

function Act-Rules($cfg) {
  $seen = @{}
  $out = New-Object System.Collections.Generic.List[object]
  $add = {
    param($key, $project)
    $k = Act-Norm $key
    $p = Act-Cut ((Act-Str $project).Trim()) $ACT_PROJECT_MAX
    if ($k.Length -lt $ACT_KEY_MIN -or $k.Length -gt $ACT_KEY_MAX -or -not $p -or $seen.ContainsKey($k)) { return }
    $seen[$k] = 1
    $out.Add(@{ key = $k; project = $p; i = $out.Count })
  }
  foreach ($r in (Get-Prop $cfg 'rules')) { if ($null -ne $r) { & $add (Get-Prop $r 'keyword') (Get-Prop $r 'project') } }
  foreach ($p in (Get-Prop $cfg 'projects')) { if ($null -ne $p) { & $add $p $p } }
  $sorted = @($out | Sort-Object -Property @{ Expression = { $_.key.Length }; Descending = $true }, @{ Expression = { $_.i } })
  return ,$sorted
}

function Act-RuleHit($seg, $rules) {
  $hay = @((Act-Norm (Get-Prop $seg 'title')), (Act-Norm (Get-Prop $seg 'app')), (Act-Norm (Get-Prop $seg 'host')))
  foreach ($r in $rules) {
    if ($hay[0].Contains($r.key) -or $hay[1].Contains($r.key) -or $hay[2].Contains($r.key)) {
      return @{ project = $r.project; key = $r.key }
    }
  }
  return $null
}

function Act-TitleKey($app, $title) {
  return (Act-Norm ((Act-Str $app) -replace '\.exe$', '')) + '|' + (Act-Norm (Act-ScrubTitle $title))
}

function Act-Classify($seg, $cfg) {
  $lists = Act-Lists (Get-Prop $cfg 'lists')
  if ((Get-Prop $seg 'incognito') -eq $true -or ((Act-Str (Get-Prop $seg 'title')) -match $ACT_PRIVATE_TITLE) -or
      (Act-ListHit $lists['private'] $seg $true)) {
    return @{ category = 'private'; project = ''; key = '' }
  }
  if (Act-ListHit $lists['distract'] $seg $false) { return @{ category = 'distraction'; project = ''; key = '' } }
  $hit = Act-RuleHit $seg (Act-Rules $cfg)
  if (Act-ListHit $lists['meeting'] $seg $false) {
    if ($hit) { return @{ category = 'meeting'; project = $hit.project; key = $hit.key } }
    return @{ category = 'meeting'; project = ''; key = '' }
  }
  if ($hit) { return @{ category = 'work'; project = $hit.project; key = $hit.key } }
  $known = Get-Prop (Get-Prop $cfg 'known') (Act-TitleKey (Get-Prop $seg 'app') (Get-Prop $seg 'title'))
  if ($known) { return @{ category = 'work'; project = (Act-Cut ([string]$known) $ACT_PROJECT_MAX); key = '' } }
  return @{ category = 'unclear'; project = ''; key = '' }
}

# Spans are two-element arrays [start, end] in ms (doubles).

function Act-MergeSpans($list) {
  $items = New-Object System.Collections.Generic.List[object]
  $i = 0
  foreach ($x in (As-Seq $list)) {
    if ($null -ne $x -and [double]$x[1] -gt [double]$x[0]) { $items.Add(@{ a = [double]$x[0]; b = [double]$x[1]; i = $i }) }
    $i++
  }
  $sorted = @($items | Sort-Object -Property @{ Expression = { $_.a } }, @{ Expression = { $_.i } })
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($x in $sorted) {
    if ($out.Count -gt 0 -and $x.a -le $out[$out.Count - 1][1]) {
      $last = $out[$out.Count - 1]
      $last[1] = [Math]::Max($last[1], $x.b)
    } else {
      $out.Add([double[]]@($x.a, $x.b))
    }
  }
  return ,$out.ToArray()
}

function Act-Intersect([double]$a, [double]$b, $spans) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($s in (As-Seq $spans)) {
    if ($null -eq $s) { continue }
    $x = [Math]::Max($a, [double]$s[0])
    $y = [Math]::Min($b, [double]$s[1])
    if ($y -gt $x) { $out.Add([double[]]@($x, $y)) }
  }
  return ,$out.ToArray()
}

function Act-Ms($v) {
  if ($v -is [datetime]) { return [double]([DateTimeOffset]$v.ToUniversalTime()).ToUnixTimeMilliseconds() }
  $t = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse((Act-Str $v), [System.Globalization.CultureInfo]::InvariantCulture,
                                 [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$t)) {
    return [double]$t.ToUnixTimeMilliseconds()
  }
  return [double]::NaN
}

function Act-Iso([double]$ms) {
  $d = [DateTimeOffset]::FromUnixTimeMilliseconds([long][Math]::Floor($ms))
  return $d.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Act-EventSpan($e) {
  $a = Act-Ms (Get-Prop $e 'timestamp')
  $d = [double](Get-Prop $e 'duration') * 1000
  if ([double]::IsNaN($a) -or -not ($d -gt 0)) { return $null }
  return ,([double[]]@($a, ($a + $d)))
}

function Act-Segments($events, $cut) {
  $actList = New-Object System.Collections.Generic.List[object]
  foreach ($e in (Get-Prop $events 'afk')) {
    if ($null -ne $e -and (Get-Prop (Get-Prop $e 'data') 'status') -eq 'not-afk') {
      $sp = Act-EventSpan $e
      if ($null -ne $sp) { $actList.Add($sp) }
    }
  }
  $active = Act-MergeSpans $actList
  $allowList = New-Object System.Collections.Generic.List[object]
  foreach ($s in (Act-MergeSpans (Get-Prop $cut 'spans'))) {
    $lo = [Math]::Max([double]$s[0], [double](Get-Prop $cut 'from'))
    $hi = [Math]::Min([double]$s[1], [double](Get-Prop $cut 'to'))
    foreach ($p in (Act-Intersect $lo $hi $active)) { $allowList.Add($p) }
  }
  $allowed = Act-MergeSpans $allowList

  $webList = New-Object System.Collections.Generic.List[object]
  $i = 0
  foreach ($e in (Get-Prop $events 'web')) {
    $sp = $null
    if ($null -ne $e) { $sp = Act-EventSpan $e }
    if ($null -ne $sp) {
      $data = Get-Prop $e 'data'
      $u = Act-UrlParts (Get-Prop $data 'url')
      $webList.Add(@{ a = $sp[0]; b = $sp[1]; host = $u.host; path = $u.path; incognito = ((Get-Prop $data 'incognito') -eq $true); i = $i })
    }
    $i++
  }
  $web = @($webList | Sort-Object -Property @{ Expression = { $_.a } }, @{ Expression = { $_.i } })

  $out = New-Object System.Collections.Generic.List[object]
  $piece = {
    param([double]$a, [double]$b, $w, $app, $title)
    if ($b -gt $a) {
      if ($null -ne $w) { $out.Add(@{ start = $a; end = $b; app = $app; title = $title; host = $w.host; path = $w.path; incognito = $w.incognito; n = $out.Count }) }
      else { $out.Add(@{ start = $a; end = $b; app = $app; title = $title; host = ''; path = ''; incognito = $false; n = $out.Count }) }
    }
  }
  foreach ($e in (Get-Prop $events 'window')) {
    if ($null -eq $e) { continue }
    $sp = Act-EventSpan $e
    if ($null -eq $sp) { continue }
    $data = Get-Prop $e 'data'
    $app = Act-CleanApp (Get-Prop $data 'app')
    $title = Act-Str (Get-Prop $data 'title')
    $browser = Act-IsBrowser $app
    foreach ($p in (Act-Intersect $sp[0] $sp[1] $allowed)) {
      if (-not $browser) { & $piece $p[0] $p[1] $null $app $title; continue }
      $at = $p[0]
      foreach ($w in $web) {
        if ($w.b -le $p[0] -or $w.a -ge $p[1]) { continue }
        $x = [Math]::Max($p[0], $w.a)
        $y = [Math]::Min($p[1], $w.b)
        if ($x -gt $at) { & $piece $at $x $null $app $title }
        & $piece ([Math]::Max($x, $at)) $y $w $app $title
        if ($y -gt $at) { $at = $y }
      }
      & $piece $at $p[1] $null $app $title
    }
  }
  $sorted = @($out | Sort-Object -Property @{ Expression = { $_.start } }, @{ Expression = { $_.n } })
  return ,$sorted
}

function Act-Identity($b) {
  if ($b.category -eq 'private') { return 'private|' + $b.app }
  $t = ''
  if ($b.category -eq 'unclear') { $t = Act-Norm $b.title }
  return ($b.category, $b.project, $b.app, $b.domain, $t) -join '|'
}

function Act-Join($list) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($b in (As-Seq $list)) {
    if ($null -eq $b) { continue }
    if ($out.Count -gt 0) {
      $last = $out[$out.Count - 1]
      if ($last.id -ceq $b.id -and ($b.start - $last.end) -le $ACT_JOIN_GAP_MS) {
        $last.end = [Math]::Max($last.end, $b.end)
        continue
      }
    }
    $out.Add($b.Clone())
  }
  return ,$out.ToArray()
}

function Act-Blocks($pieces, $cfg) {
  $made = New-Object System.Collections.Generic.List[object]
  $i = 0
  foreach ($p in (As-Seq $pieces)) {
    if ($null -eq $p) { continue }
    $c = Act-Classify $p $cfg
    $domain = $p.host
    if ($c.category -eq 'private') { $domain = '' }
    $title = ''
    # A browser window the extension did not see: its title is never sent.
    if ($c.category -eq 'unclear' -and (Act-TitleSendable $p.app $p.title) -and -not ((Act-IsBrowser $p.app) -and -not $p.host)) {
      $title = Act-ScrubTitle $p.title
    }
    $b = @{ start = [double]$p.start; end = [double]$p.end; app = (Act-CleanApp $p.app); domain = (Act-Str $domain);
            category = $c.category; project = $c.project; key = $c.key; title = $title; i = $i }
    $b.id = Act-Identity $b
    $made.Add($b)
    $i++
  }
  $list = Act-Join @($made | Sort-Object -Property @{ Expression = { $_.start } }, @{ Expression = { $_.i } })
  $kept = New-Object System.Collections.Generic.List[object]
  for ($j = 0; $j -lt $list.Length; $j++) {
    $b = $list[$j]
    if (($b.end - $b.start) -ge $ACT_MIN_BLOCK_MS) { $kept.Add($b); continue }
    $prev = $null
    if ($kept.Count -gt 0) { $prev = $kept[$kept.Count - 1] }
    $next = $null
    if ($j + 1 -lt $list.Length) { $next = $list[$j + 1] }
    if ($null -ne $prev -and ($b.start - $prev.end) -le $ACT_JOIN_GAP_MS) { $prev.end = [Math]::Max($prev.end, $b.end) }
    elseif ($null -ne $next -and ($next.start - $b.end) -le $ACT_JOIN_GAP_MS) { $next.start = [Math]::Min($next.start, $b.start) }
  }
  $res = New-Object System.Collections.Generic.List[object]
  foreach ($b in (Act-Join $kept)) { if (($b.end - $b.start) -ge $ACT_MIN_BLOCK_MS) { $res.Add($b) } }
  return ,$res.ToArray()
}

# What is sent: these seven fields, never the title.
function Act-Payload($blocks) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($b in (As-Seq $blocks)) {
    if ($null -eq $b) { continue }
    $out.Add([ordered]@{ start = (Act-Iso $b.start); end = (Act-Iso $b.end); app = $b.app; domain = $b.domain;
                         category = $b.category; project = $b.project; key = $b.key })
  }
  return ,$out.ToArray()
}

# ------------------------------------------------------------------ self test

function Same($a, $b) { return ((Act-Str $a) -ceq (Act-Str $b)) }

function Run-SelfTest {
  $fx = Get-Content -Raw -Encoding UTF8 $Fixtures | ConvertFrom-Json
  $ok = 0; $bad = 0
  foreach ($c in @($fx.url)) {
    $u = Act-UrlParts $c.in
    if ((Same $u.host $c.host) -and (Same $u.path $c.path)) { $ok++ } else { $bad++; Write-Output ('FAIL url ' + $c.in + ' -> ' + $u.host + ' ' + $u.path) }
  }
  foreach ($c in @($fx.scrub)) {
    $s = Act-ScrubTitle $c.in
    if (Same $s $c.out) { $ok++ } else { $bad++; Write-Output ('FAIL scrub ' + $c.in + ' -> ' + $s) }
  }
  foreach ($c in @($fx.sendable)) {
    $r = Act-TitleSendable $c.app $c.title
    if ($r -eq $c.want) { $ok++ } else { $bad++; Write-Output ('FAIL sendable ' + $c.title + ' -> ' + $r) }
  }
  foreach ($c in @($fx.classify)) {
    $r = Act-Classify $c.seg $c.cfg
    if ((Same $r.category $c.want.category) -and (Same $r.project $c.want.project) -and (Same $r.key $c.want.key)) { $ok++ }
    else { $bad++; Write-Output ('FAIL classify ' + $c.name + ' -> ' + $r.category + ' ' + $r.project + ' ' + $r.key) }
  }
  foreach ($c in @($fx.pipeline)) {
    $cut = @{ from = (Act-Ms $c.cut.from); to = (Act-Ms $c.cut.to); spans = @() }
    $sp = New-Object System.Collections.Generic.List[object]
    foreach ($s in @($c.cut.spans)) { $sp.Add([double[]]@((Act-Ms $s[0]), (Act-Ms $s[1]))) }
    $cut.spans = $sp.ToArray()
    $got = Act-Payload (Act-Blocks (Act-Segments $c.events $cut) $c.cfg)
    $want = @($c.want)
    $same = ($got.Length -eq $want.Length)
    for ($i = 0; $same -and $i -lt $got.Length; $i++) {
      foreach ($k in @('start', 'end', 'app', 'domain', 'category', 'project', 'key')) {
        if (-not (Same $got[$i][$k] (Get-Prop $want[$i] $k))) { $same = $false }
      }
    }
    if ($same) { $ok++ } else { $bad++; Write-Output ('FAIL pipeline ' + $c.name + ': ' + (ConvertTo-Json @($got) -Depth 6 -Compress)) }
  }
  Write-Output ('selftest: ' + $ok + ' ok, ' + $bad + ' failed')
  if ($bad) { exit 1 }
  exit 0
}

if ($SelfTest) { Run-SelfTest }

# ----------------------------------------------------------------- one run

$CLASSIFY_BATCH = 8                     # this many unclear titles waiting: ask now
$CLASSIFY_WAIT_MS = 60 * 60000          # ... or the oldest has waited this long
$CLASSIFY_MAX = 20
$PENDING_MAX_MS = 12 * 3600000          # an unclear title not answered by then is let go
$KNOWN_MAX_MS = 7 * 86400000            # Gemini's answers are reused this long
$FIRST_LOOK_MS = 30 * 60000             # the first run looks back this far
$LOOK_MAX_MS = 24 * 3600000
$OPEN_MS = 2 * 60000                    # a block ending this recently may still grow

function Write-Log([string]$line) {
  try {
    $dir = Split-Path $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 200000) { Remove-Item $LogFile }
    Add-Content -Path $LogFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm') + ' ' + $line) -Encoding UTF8
  } catch { }
}

function Read-Json([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return (Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json)
}

function Save-Json([string]$path, $obj) {
  $dir = Split-Path $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, (ConvertTo-Json $obj -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding $false))
}

function To-Hash($obj) {
  $h = @{}
  if ($null -eq $obj) { return $h }
  foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  return $h
}

$conf = Read-Json $ConfigFile
if ($null -eq $conf) { Write-Output 'Not set up: run install.ps1 with the line from ProBeing Settings.'; exit 2 }
$url = ([string]$conf.url).TrimEnd('/')
$anon = [string]$conf.key
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString ([string]$conf.token))))
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Call-ProBeing($body) {
  $json = ConvertTo-Json $body -Depth 10 -Compress
  $headers = @{ Authorization = 'Bearer ' + $anon; apikey = $anon; 'x-device-token' = $token }
  return Invoke-RestMethod -Method Post -Uri ($url + '/functions/v1/activity-ingest') -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
}

function Get-AW([string]$path) {
  return Invoke-RestMethod -Method Get -Uri ($AwUrl + $path) -TimeoutSec 20
}

function Get-Events($bucket, [double]$from, [double]$to) {
  $list = New-Object System.Collections.Generic.List[object]
  if (-not $bucket) { return ,$list.ToArray() }
  $q = '/api/0/buckets/' + [uri]::EscapeDataString($bucket) + '/events?start=' + [uri]::EscapeDataString((Act-Iso $from)) +
       '&end=' + [uri]::EscapeDataString((Act-Iso $to)) + '&limit=20000'
  $r = Invoke-RestMethod -Method Get -Uri ($AwUrl + $q) -TimeoutSec 20
  foreach ($e in $r) { if ($null -ne $e) { $list.Add($e) } }
  return ,$list.ToArray()
}

try {
  $now = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $state = Read-Json $StateFile
  $sentUntil = [double]::NaN
  if ($null -ne $state -and $state.sentUntil) { $sentUntil = Act-Ms $state.sentUntil }
  $pending = To-Hash (Get-Prop $state 'pending')
  $known = To-Hash (Get-Prop $state 'known')
  $from = $now - $FIRST_LOOK_MS
  if (-not [double]::IsNaN($sentUntil)) { $from = $sentUntil }
  if ($from -lt $now - $LOOK_MAX_MS) { $from = $now - $LOOK_MAX_MS }

  $cfg = Call-ProBeing @{ op = 'config'; from = (Act-Iso $from) }
  $spanList = New-Object System.Collections.Generic.List[object]
  foreach ($s in @($cfg.spans)) { if ($null -ne $s) { $spanList.Add([double[]]@((Act-Ms $s[0]), (Act-Ms $s[1]))) } }
  $spans = Act-MergeSpans $spanList
  $knownNames = @{}
  foreach ($k in $known.Keys) { $knownNames[$k] = Get-Prop $known[$k] 'project' }

  $blocks = @()
  if ((Act-Intersect $from $now $spans).Length -gt 0) {
    $buckets = Get-AW '/api/0/buckets/'
    $win = $null; $afk = $null; $webIds = @()
    foreach ($p in $buckets.PSObject.Properties) {
      $type = [string](Get-Prop $p.Value 'type')
      if ($type -eq 'currentwindow' -and -not $win) { $win = $p.Name }
      elseif ($type -eq 'afkstatus' -and -not $afk) { $afk = $p.Name }
      elseif ($type -eq 'web.tab.current') { $webIds += $p.Name }
    }
    $look = $from - 30 * 60000
    $webEvents = New-Object System.Collections.Generic.List[object]
    foreach ($id in $webIds) { foreach ($e in (Get-Events $id $look $now)) { $webEvents.Add($e) } }
    $events = @{ window = (Get-Events $win $look $now); afk = (Get-Events $afk $look $now); web = $webEvents.ToArray() }
    $classCfg = @{ lists = $cfg.lists; rules = $cfg.rules; projects = $cfg.projects; known = $knownNames }
    $blocks = Act-Blocks (Act-Segments $events @{ from = $from; to = $now; spans = $spans }) $classCfg
  }

  $counts = @{}
  foreach ($b in $blocks) { $counts[$b.category] = 1 + [int]$counts[$b.category] }
  $summary = ($counts.Keys | Sort-Object | ForEach-Object { $_ + ' ' + $counts[$_] }) -join ', '
  if ($Check) {
    Write-Output ('Paired as: ' + $cfg.device + '. Working now: ' + $cfg.working + '.')
    Write-Output ('Would send ' + $blocks.Length + ' blocks (' + $summary + '). Nothing was sent.')
    exit 0
  }

  if ($blocks.Length -gt 0) {
    $res = Call-ProBeing @{ op = 'ingest'; blocks = (Act-Payload $blocks) }
    $last = $blocks[$blocks.Length - 1]
    if ($now - $last.end -gt $OPEN_MS) { $sentUntil = $last.end } else { $sentUntil = $last.start }
    foreach ($b in $blocks) {
      # In the watcher's own break it only looks for the way back: no titles kept for Gemini.
      if ($b.category -ne 'unclear' -or -not $b.title -or $cfg.autoBreak -eq $true) { continue }
      $k = Act-TitleKey $b.app $b.title
      $have = $pending[$k]
      $starts = @()
      $first = $now
      if ($null -ne $have) {
        $had = Get-Prop $have 'blocks'
        if ($null -ne $had) { $starts = @($had) }
        $first = [double](Get-Prop $have 'first')
      }
      $iso = Act-Iso $b.start
      if ($starts -notcontains $iso) { $starts += $iso }
      $pending[$k] = @{ title = $b.title; app = $b.app; domain = $b.domain; first = $first; blocks = @($starts | Select-Object -Last 200) }
    }
    Write-Log ('sent ' + $blocks.Length + ' blocks (' + $summary + '), stored ' + $res.stored)
  } else {
    $sentUntil = [Math]::Max($from, $now - $OPEN_MS)
  }

  # Unclear titles: one Gemini call for a batch, on the server's budget.
  foreach ($k in @($pending.Keys)) { if ($now - [double](Get-Prop $pending[$k] 'first') -gt $PENDING_MAX_MS) { $pending.Remove($k) } }
  foreach ($k in @($known.Keys)) { if ($now - [double](Get-Prop $known[$k] 'at') -gt $KNOWN_MAX_MS) { $known.Remove($k) } }
  $oldest = $now
  foreach ($k in $pending.Keys) { $oldest = [Math]::Min($oldest, [double](Get-Prop $pending[$k] 'first')) }
  if ($pending.Count -ge $CLASSIFY_BATCH -or ($pending.Count -gt 0 -and $now - $oldest -ge $CLASSIFY_WAIT_MS)) {
    $keys = @($pending.Keys | Sort-Object { [double](Get-Prop $pending[$_] 'first') } | Select-Object -First $CLASSIFY_MAX)
    $items = @()
    foreach ($k in $keys) {
      $p = $pending[$k]
      $items += @{ key = $k; title = (Get-Prop $p 'title'); app = (Get-Prop $p 'app'); domain = (Get-Prop $p 'domain');
                   blocks = (Get-Prop $p 'blocks') }
    }
    $ans = Call-ProBeing @{ op = 'classify'; items = $items }
    if ($ans.act -eq 'filed' -or $ans.act -eq 'nothing' -or $ans.act -eq 'no-projects') {
      foreach ($r in @($ans.results)) { if ($null -ne $r -and $r.project) { $known[$r.key] = @{ project = $r.project; at = $now } } }
      foreach ($k in $keys) { $pending.Remove($k) }
    }
    Write-Log ('asked about ' + $items.Length + ' unclear titles: ' + $ans.act)
  }

  Save-Json $StateFile @{ sentUntil = (Act-Iso $sentUntil); pending = $pending; known = $known }
} catch {
  Write-Log ('error: ' + $_.Exception.Message)
  if ($Check) { Write-Output ('Error: ' + $_.Exception.Message) }
  exit 1
}
