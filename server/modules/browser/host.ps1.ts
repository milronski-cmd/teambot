/**
 * PowerShell helper for "Mijn bureaublad" (Windows host control). Input arrives as JSON on stdin
 * (never on the command line), output is one JSON object on stdout. Every mutating action first
 * re-verifies that the target window still belongs to the same process and that the process is on
 * the allowlist, so a reused window handle can never redirect a click to another app.
 */
export const HOST_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$inp = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Done($o) { [Console]::Out.Write((ConvertTo-Json -InputObject $o -Compress -Depth 6)); exit 0 }
function Fail($m) { Done @{ error = $m } }
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Drawing;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TbHost {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  // Classic EDIT control with ES_PASSWORD (UI Automation does not always report IsPassword for Win32 controls).
  public static bool PasswordStyle(IntPtr h) { return h != IntPtr.Zero && (GetWindowLong(h, -16) & 0x20) != 0; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static List<IntPtr> Top() { var l = new List<IntPtr>(); EnumWindows((h, p) => { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(80); }
    if (GetForegroundWindow() == h) return true;
    // Attach to the foreground thread so Windows allows the switch. (A lone Alt tap would also work, but puts the
    // target window in menu mode and swallows the next keystroke.)
    uint dummy;
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
    // Fallback without synthetic keystrokes (those could end up as characters in the target).
    if (GetForegroundWindow() != h) { SwitchToThisWindow(h, true); System.Threading.Thread.Sleep(80); }
    System.Threading.Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }
  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; return i; }
  public static void Click(int x, int y, bool right, bool dbl) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
    int n = dbl ? 2 : 1;
    for (int k = 0; k < n; k++) { Send(new INPUT[] { M(down), M(up) }); System.Threading.Thread.Sleep(60); }
  }
  public static void Wheel(int x, int y, int delta) { SetCursorPos(x, y); var i = M(0x0800); i.u.mi.mouseData = (uint)delta; Send(new INPUT[] { i }); }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\n') { Send(new INPUT[] { K(0x0D, 0, 0), K(0x0D, 0, 2) }); continue; }
      if (c == '\r') continue;
      Send(new INPUT[] { K(0, (ushort)c, 4), K(0, (ushort)c, 6) });
      System.Threading.Thread.Sleep(8);
    }
  }
  public static void Keys(ushort[] vks) {
    var list = new List<INPUT>();
    foreach (var v in vks) list.Add(K(v, 0, 0));
    for (int i = vks.Length - 1; i >= 0; i--) list.Add(K(vks[i], 0, 2));
    Send(list.ToArray());
  }
  public static string Capture(IntPtr h, string file, int[] redact) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return "leeg venster";
    using (var bmp = new Bitmap(w, hh)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr dc = g.GetHdc();
        bool ok = PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc);
        if (!ok) return "PrintWindow mislukt";
        for (int i = 0; i + 3 < redact.Length; i += 4) g.FillRectangle(Brushes.Black, redact[i] - r.L, redact[i + 1] - r.T, redact[i + 2], redact[i + 3]);
      }
      bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
    }
    return "";
  }
}
"@ -ReferencedAssemblies System.Drawing
[void][TbHost]::SetProcessDPIAware()

$deny = @('teambot','electron','consent','credentialuibroker','lockapp','logonui','useraccountcontrolsettings')
function ProcName($procId) { $p = Get-Process -Id $procId -ErrorAction SilentlyContinue; if ($p) { return $p.ProcessName.ToLower() } else { return '' } }
function Info($h) {
  $r = New-Object TbHost+RECT; [void][TbHost]::GetWindowRect($h, [ref]$r)
  $procId = [TbHost]::Pid($h)
  return [pscustomobject]@{ hwnd = [int64]$h; pid = [int]$procId; process = (ProcName $procId); title = [TbHost]::Title($h); x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T; minimized = [TbHost]::IsIconic($h) }
}
function Target() {
  $h = [IntPtr][int64]$inp.hwnd
  if (-not [TbHost]::IsWindow($h)) { Fail 'Het venster bestaat niet meer.' }
  $i = Info $h
  if ($i.pid -ne [int]$inp.pid) { Fail 'Het venster hoort niet meer bij hetzelfde programma; bekijk het venster opnieuw.' }
  $allow = @($inp.allow | ForEach-Object { "$_".ToLower() })
  if ($deny -contains $i.process -or $i.title -match 'TeamBot') { Fail 'Dit venster mag nooit door een bot bediend worden.' }
  if (-not ($allow -contains $i.process)) { Fail ("Programma '" + $i.process + "' staat niet op de lijst met toegestane apps.") }
  return $h
}
$script:uiaReady = $false
function Uia() {
  if ($script:uiaReady) { return }
  Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes
  # Classic Win32/WinForms controls (Edit, Button, ...) are only recognised with the client-side proxies; without them
  # they all show up as an anonymous "Pane".
  try {
    Add-Type -AssemblyName UIAutomationClientsideProviders
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly([UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
  } catch { }
  $script:uiaReady = $true
}
function FindByRuntime($h, $rid) {
  Uia
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $ids = [int[]]@($rid -split '\.' | ForEach-Object { [int]$_ })
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::RuntimeIdProperty, $ids)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
}

switch ($inp.action) {
  'windows' {
    $out = @()
    foreach ($h in [TbHost]::Top()) { $out += (Info $h) }
    Done @{ windows = @($out) }
  }
  'inspect' {
    $h = Target
    Uia
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $max = [int]$inp.max
    $list = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($root, 0))
    while ($stack.Count -gt 0 -and $list.Count -lt $max) {
      $pair = $stack.Pop(); $el = $pair[0]; $depth = $pair[1]
      try {
        $c = $el.Current
        $rect = $c.BoundingRectangle
        $cls = [string]$c.ClassName
        $isEdit = $cls -match '(^|\.)(EDIT|RichEdit\w*)(\.|$)'
        $isPw = $c.IsPassword -or ($isEdit -and [TbHost]::PasswordStyle([IntPtr]$c.NativeWindowHandle))
        $val = ''
        if (-not $isPw) {
          try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = [string]$vp.Current.Value } catch { }
          if ($val.Length -gt 200) { $val = $val.Substring(0, 200) }
        }
        $invoke = $false; try { [void]$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $invoke = $true } catch { }
        if ($depth -gt 0) {
          $type = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
          if ($type -eq 'Pane' -and $cls) {
            # Without client-side proxies classic Win32/WinForms controls all look like "Pane": use the window class.
            if ($isEdit) { $type = 'Edit' }
            elseif ($cls -match '(^|\.)BUTTON(\.|$)') { $type = 'Button' }
            elseif ($cls -match '(^|\.)COMBOBOX(\.|$)') { $type = 'ComboBox' }
            elseif ($cls -match '(^|\.)LISTBOX(\.|$)') { $type = 'List' }
            elseif ($cls -match '(^|\.)STATIC(\.|$)') { $type = 'Text' }
          }
          [void]$list.Add([pscustomobject]@{ depth = $depth; type = $type; name = $c.Name; id = $c.AutomationId; enabled = $c.IsEnabled; password = $isPw; value = $val; invoke = $invoke; runtime = (($el.GetRuntimeId()) -join '.'); x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height; offscreen = $c.IsOffscreen })
        }
        if ($depth -lt 12) {
          $kids = New-Object System.Collections.ArrayList
          $k = $walker.GetFirstChild($el)
          while ($k -ne $null -and $kids.Count -lt 200) { [void]$kids.Add($k); $k = $walker.GetNextSibling($k) }
          for ($j = $kids.Count - 1; $j -ge 0; $j--) { $stack.Push(@($kids[$j], ($depth + 1))) }
        }
      } catch { }
    }
    Done @{ window = (Info $h); elements = @($list); truncated = ($stack.Count -gt 0) }
  }
  'screenshot' {
    $h = Target
    $redact = [int[]]@($inp.redact | ForEach-Object { [int]$_ })
    $err = [TbHost]::Capture($h, [string]$inp.out, $redact)
    if ($err) { Fail $err }
    Done @{ ok = $true; window = (Info $h) }
  }
  'click' {
    $h = Target
    if (-not [TbHost]::Focus($h)) { Fail 'Kon het venster niet naar voren halen.' }
    if ($inp.runtime) {
      $el = FindByRuntime $h $inp.runtime
      if ($el -eq $null) { Fail 'Het element is niet meer gevonden; bekijk het venster opnieuw.' }
      if ($inp.useInvoke) {
        try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Done @{ ok = $true; via = 'invoke' } } catch { }
      }
      $r = $el.Current.BoundingRectangle
      $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    } else {
      $i = Info $h
      $x = [int]($i.x + [int]$inp.x); $y = [int]($i.y + [int]$inp.y)
      if ($x -lt $i.x -or $y -lt $i.y -or $x -gt ($i.x + $i.w) -or $y -gt ($i.y + $i.h)) { Fail 'Het punt ligt buiten het venster.' }
    }
    [TbHost]::Click($x, $y, [bool]$inp.right, [bool]$inp.double)
    Done @{ ok = $true; via = 'mouse'; x = $x; y = $y }
  }
  'scroll' {
    $h = Target
    if (-not [TbHost]::Focus($h)) { Fail 'Kon het venster niet naar voren halen.' }
    $i = Info $h
    [TbHost]::Wheel([int]($i.x + $i.w / 2), [int]($i.y + $i.h / 2), [int]$inp.delta)
    Done @{ ok = $true }
  }
  'type' {
    $h = Target
    if (-not [TbHost]::Focus($h)) { Fail 'Kon het venster niet naar voren halen.' }
    if ($inp.runtime) {
      $el = FindByRuntime $h $inp.runtime
      if ($el -eq $null) { Fail 'Het element is niet meer gevonden; bekijk het venster opnieuw.' }
      if ($el.Current.IsPassword -or [TbHost]::PasswordStyle([IntPtr]$el.Current.NativeWindowHandle)) { Fail 'Dit is een wachtwoordveld. Een bot typt nooit wachtwoorden; vraag de gebruiker dit zelf te doen.' }
      try { $el.SetFocus() } catch { }
    }
    [TbHost]::TypeText([string]$inp.text)
    Done @{ ok = $true }
  }
  'key' {
    $h = Target
    if (-not [TbHost]::Focus($h)) { Fail 'Kon het venster niet naar voren halen.' }
    $vks = [uint16[]]@($inp.vks | ForEach-Object { [uint16]$_ })
    [TbHost]::Keys($vks)
    Done @{ ok = $true }
  }
  default { Fail 'Onbekende actie' }
}
`;
