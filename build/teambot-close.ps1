# Closes a running TeamBot before the installer or uninstaller touches its folder (build/installer.nsh,
# customCheckAppRunning). Never by program name: only processes whose program lies in the install folder
# ($env:TEAMBOT_INSTDIR) and the processes they started (helpers such as the dictation PowerShell or a voice or AI
# engine: electron-builder's own check ended TeamBot.exe only, a helper kept a file of the install folder in use, the
# old uninstaller could not move it, and the installer stopped with code 2 while TeamBot was already gone).
#  1. Remember TeamBot's processes and everything they started (by parent, started after the parent).
#  2. Ask TeamBot to quit ("TeamBot.exe --quit": the running TeamBot closes its server and helpers itself) and wait.
#  3. End what is left of exactly those processes (checked by start time, so a reused process number is never hit),
#     never this script or the installer that runs it, and wait until Windows has released them.
# Exit code 0 = nothing of TeamBot runs any more, 1 = something could not be ended.
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:TEAMBOT_INSTDIR
$exe = $env:TEAMBOT_EXE
$askMs = if ($env:TEAMBOT_CLOSE_WAIT_MS) { [int]$env:TEAMBOT_CLOSE_WAIT_MS } else { 15000 }
if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { exit 0 }
$dir = [System.IO.Path]::GetFullPath($dir).TrimEnd('\') + '\'

# This script and everything above it (the uninstaller, the installer, and during an automatic update the TeamBot that
# started that installer): never followed down, and only the TeamBot itself is ended (it quits for the update anyway).
$self = [int]$PID
$procs = @{}
foreach ($p in @(Get-CimInstance Win32_Process)) { $procs[[int]$p.ProcessId] = $p }
$skip = @($self)
$cur = $self
for ($i = 0; $i -lt 16; $i++) {
  if (-not $procs.ContainsKey($cur)) { break }
  $up = [int]$procs[$cur].ParentProcessId
  if (-not $up -or $skip -contains $up -or -not $procs.ContainsKey($up)) { break }
  # Every ancestor is spared (an uninstaller may run from inside the install folder), except TeamBot itself.
  $exePath = $procs[$up].ExecutablePath
  $isApp = $exe -and $exePath -and $exePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) -and ([System.IO.Path]::GetFileName($exePath) -ieq $exe)
  if (-not $isApp) { $skip += $up }
  $cur = $up
}

function Snapshot {
  $all = @(Get-CimInstance Win32_Process)
  $byId = @{}
  foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  $found = @{}
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($skip -contains $id) { continue }
    if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) { $found[$id] = $p.CreationDate }
  }
  # Everything those processes started, and what that started (only if it started after its parent: process numbers
  # are reused, a parent number alone proves nothing).
  do {
    $n = $found.Count
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      $pp = [int]$p.ParentProcessId
      if ($found.ContainsKey($id) -or ($skip -contains $id) -or -not $found.ContainsKey($pp)) { continue }
      if ($p.CreationDate -and $found[$pp] -and $p.CreationDate -lt $found[$pp]) { continue }
      $found[$id] = $p.CreationDate
    }
  } while ($found.Count -ne $n)
  return $found
}

function Alive($set) {
  # Get-Process is fast; the start time must match (a reused process number is someone else).
  $left = @{}
  foreach ($id in @($set.Keys)) {
    $p = Get-Process -Id $id
    if (-not $p) { continue }
    $t = $p.StartTime
    if (-not $t -or -not $set[$id] -or [math]::Abs(($t - $set[$id]).TotalSeconds) -lt 2) { $left[$id] = $set[$id] }
  }
  return $left
}

function InFolder($id) {
  $p = Get-Process -Id $id
  return ($p -and $p.Path -and $p.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase))
}

$tree = Snapshot
if ($tree.Count -eq 0) { exit 0 }
Write-Output "TeamBot draait nog ($($tree.Count) processen); vragen om af te sluiten."

# Ask nicely: a second TeamBot with --quit hands the request to the running one, which closes its server and helpers.
$app = if ($exe) { Join-Path $dir $exe } else { '' }
if ($app -and (Test-Path -LiteralPath $app) -and $askMs -gt 0) {
  Start-Process -FilePath $app -ArgumentList '--quit' -WindowStyle Hidden
  $until = (Get-Date).AddMilliseconds($askMs)
  while ((Get-Date) -lt $until) {
    Start-Sleep -Milliseconds 250
    $mine = @((Alive $tree).Keys | Where-Object { InFolder $_ })
    if ($mine.Count -eq 0) { break }
  }
}

# Whatever is still there of TeamBot (also helpers it left behind, and the --quit helper itself): ended.
for ($round = 0; $round -lt 5; $round++) {
  $left = Alive $tree
  $now = Snapshot
  foreach ($id in $now.Keys) { if (-not $left.ContainsKey($id)) { $left[$id] = $now[$id] } }
  if ($left.Count -eq 0) { break }
  foreach ($id in @($left.Keys)) {
    Write-Output "Beeindigen: $id"
    Stop-Process -Id $id -Force
  }
  $tree = $left
  Start-Sleep -Milliseconds 500
}
if ((Alive $tree).Count -gt 0) { exit 1 }
# Windows releases the files of an ended process a moment later (a virus scanner can hold them a little longer).
Start-Sleep -Milliseconds 1000
exit 0
