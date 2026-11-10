# TeamBot watchdog (0.4.4, P14): a health check outside the app. A scheduled task of the user himself (no admin rights,
# made by build/installer.nsh as "TeamBot Wachter (<domain> <user>)") runs this every 10 minutes. It reads only
# <data>\health\heartbeat.json, which the server writes every minute (server/modules/health/heartbeat.ts), and
# <data>\health\stopped.json, the "bewust gestopt" marker. It never reads the database or keys and never calls an AI.
#
# Only a crash or a hang counts:
#   - stopped on purpose: the heartbeat says stopped, or stopped.json was written during this run of TeamBot (Afsluiten,
#     an update, a restart, Windows signing off, the installer) -> "stopped", nothing is asked;
#   - the pc was restarted since the last heartbeat -> "stopped" (TeamBot did not crash, Windows went away);
#   - the process of the heartbeat is gone -> "down";
#   - the process runs but http://127.0.0.1:<port>/healthz does not answer, also not after a second try a minute later
#     -> "hang". A server that answers is never a hang, however old the heartbeat (a pc that just woke up).
# The finding goes to <data>\health\watchdog.json (shown in Instellingen > Hoe gaat het met TeamBot?).
# For "down" or "hang" it asks once per incident (one run of TeamBot) in a Windows window: "TeamBot draait niet sinds
# 09:12. Wil je TeamBot opnieuw starten?". After No it does not ask again until TeamBot has run normally once more.
# While a fullscreen program, a game or a presentation is on screen it does not ask (and asks at a later run).
# Yes stops only the hanging TeamBot process of the heartbeat (its own PID, checked by start time) and starts TeamBot.
#
# Windows PowerShell 5.1. Test parameters: -NoPopup only writes the finding; -Answer Yes|No answers instead of the
# window; -ConfirmSeconds is the wait before the second try; -BusyState stands in for the screen state.
# The idea comes from OpenMausBot's Sentinel (Apache-2.0); this is our own code.
param(
  [string]$DataDir = (Join-Path $env:APPDATA 'TeamBot'),
  [switch]$NoPopup,
  [ValidateSet('', 'Yes', 'No')][string]$Answer = '',
  [int]$ConfirmSeconds = 60,
  [int]$BusyState = -1
)
$ErrorActionPreference = 'Stop'
$health = Join-Path $DataDir 'health'
$hbFile = Join-Path $health 'heartbeat.json'
$outFile = Join-Path $health 'watchdog.json'
$markerFile = Join-Path $health 'stopped.json'
$toldFile = Join-Path $health 'watchdog-told.txt'

if (-not (Test-Path -LiteralPath $hbFile)) { exit 0 }
try { $hb = Get-Content -LiteralPath $hbFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { exit 0 }

function As-Utc($v) {
  if ($v -is [DateTime]) { return $v.ToUniversalTime() }
  return [DateTime]::Parse([string]$v, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
$beat = As-Utc $hb.at
$boot = As-Utc $hb.boot
$finding = [ordered]@{ at = ''; status = ''; since = $hb.at; detail = ''; asked = $false; answer = '' }

function Write-Finding([string]$status, [string]$detail) {
  $finding.at = (Get-Date).ToUniversalTime().ToString('o')
  $finding.status = $status
  $finding.detail = $detail
  $tmp = "$outFile.tmp"
  [System.IO.File]::WriteAllText($tmp, ($finding | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $outFile -Force
}
function Clear-Told { if (Test-Path -LiteralPath $toldFile) { Remove-Item -LiteralPath $toldFile -Force } }

# Stopped on purpose.
if ($hb.stopped -eq $true) { Write-Finding 'stopped' 'TeamBot is netjes afgesloten.'; Clear-Told; exit 0 }
if (Test-Path -LiteralPath $markerFile) {
  $marked = (Get-Item -LiteralPath $markerFile).LastWriteTimeUtc
  # Written during this run of TeamBot, and no heartbeats long after it (a stop that did not happen does not count).
  if ($marked -ge $boot.AddSeconds(-5) -and $marked -ge $beat.AddMinutes(-2)) { Write-Finding 'stopped' 'TeamBot is bewust gestopt.'; Clear-Told; exit 0 }
}
# The pc was restarted or shut down since the last heartbeat: Windows went away, TeamBot did not crash.
try {
  $up = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
  if ($up -gt $beat) { Write-Finding 'stopped' 'De pc is opnieuw opgestart.'; Clear-Told; exit 0 }
} catch { }

# The process of this heartbeat (a PID that Windows gave to another program since does not count).
$proc = Get-Process -Id ([int]$hb.pid) -ErrorAction SilentlyContinue
$alive = $false
if ($proc) {
  try { $alive = [Math]::Abs(($proc.StartTime.ToUniversalTime() - $boot).TotalMinutes) -lt 10 } catch { $alive = $true }
}
function Test-Answers {
  if ([int]$hb.port -le 0) { return $false }
  try { return (Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/healthz" -f [int]$hb.port) -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200 } catch { return $false }
}

if (-not $alive) {
  $status = 'down'; $detail = 'Het programma draait niet meer.'
} elseif (Test-Answers) {
  Write-Finding 'ok' ''; Clear-Told; exit 0
} else {
  # One busy moment is not a hang: try once more.
  if ($ConfirmSeconds -gt 0) { Start-Sleep -Seconds $ConfirmSeconds }
  if (Test-Answers) { Write-Finding 'ok' ''; Clear-Told; exit 0 }
  $status = 'hang'
  $fresh = ((Get-Date).ToUniversalTime() - $beat).TotalMinutes -le 5
  $detail = if ($fresh) { 'TeamBot draait, maar antwoordt niet.' } else { 'TeamBot draait, maar de hartslag staat stil.' }
}
Write-Finding $status $detail

if ($hb.notify -eq $false -or $NoPopup) { exit 0 }
# Once per incident: one run of TeamBot (its start time) is asked about once, whatever the answer.
$key = [string]$hb.boot
if ((Test-Path -LiteralPath $toldFile) -and ((Get-Content -LiteralPath $toldFile -Raw).Trim() -eq $key)) { exit 0 }

# Not in the middle of a fullscreen program, a game or a presentation (Windows' own "do not disturb" state).
$state = $BusyState
if ($state -lt 0) {
  try {
    Add-Type -Namespace TeamBotWatch -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);' -ErrorAction Stop
    $s = 0
    if ([TeamBotWatch.Shell]::SHQueryUserNotificationState([ref]$s) -eq 0) { $state = $s }
  } catch { $state = -1 }
}
# 2 = a fullscreen program, 3 = a game (Direct3D fullscreen), 4 = presentation mode: ask at a later run.
if ($state -in 2, 3, 4) { exit 0 }

[System.IO.File]::WriteAllText($toldFile, $key)
$time = $beat.ToLocalTime().ToString('HH:mm')
$text = if ($status -eq 'down') { "TeamBot draait niet sinds $time." } else { "TeamBot reageert niet sinds $time." }
$reply = $Answer
if (-not $reply) {
  Add-Type -AssemblyName System.Windows.Forms
  $reply = [string][System.Windows.Forms.MessageBox]::Show("$text`r`n`r`n$detail Je routines en bots staan stil.`r`n`r`nWil je TeamBot opnieuw starten?", 'TeamBot', 'YesNo', 'Warning', 'Button1', 'DefaultDesktopOnly')
}
$finding.asked = $true
$finding.answer = $reply
Write-Finding $status $detail
if ($reply -ne 'Yes') { exit 0 }
if ($alive -and $proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
$exe = [string]$hb.exe
if ($exe -and (Test-Path -LiteralPath $exe) -and ((Split-Path -Leaf $exe) -notmatch '^node(\.exe)?$')) { Start-Process -FilePath $exe }
