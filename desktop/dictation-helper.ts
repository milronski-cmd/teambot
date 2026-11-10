/**
 * Windows helper for the dictation hotkey: one long-lived powershell.exe that compiles the C# below once (cached as a
 * DLL) and answers one JSON request per line. It can tell when you let go of the hotkey (GetAsyncKeyState), what has
 * the focus (process, password field via Win32 ES_PASSWORD or UI Automation IsPassword, elevated), and it presses
 * Ctrl+V (or types Unicode text) — but only after all modifier keys are up, and it re-checks right before sending that
 * the focus is not a password field, not a Windows security prompt and not an administrator window (Windows would
 * silently drop the keys there).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const DICTATION_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName Accessibility
try {
  Add-Type -AssemblyName UIAutomationClientsideProviders
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly([UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
} catch { }
$refs = @(
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [Accessibility.IAccessible].Assembly.Location
)
$src = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class TbDict {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr t, int cls, out int info, int len, out int ret);
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

  static JavaScriptSerializer Js = new JavaScriptSerializer();
  // Windows security prompts and the lock screen: never type there.
  static readonly string[] Blocked = new string[] { "consent", "credentialuibroker", "lockapp", "logonui", "useraccountcontrolsettings" };
  static bool selfElevated = false;
  // What UI Automation reported as focused last time (control type only; for diagnostics).
  static string lastFocus = "";

  public static void Init() {
    try { selfElevated = Elevated((uint)Process.GetCurrentProcess().Id); } catch { }
  }

  public static string Handle(string line) {
    object id = null;
    try {
      var q = Js.DeserializeObject(line) as Dictionary<string, object>;
      if (q == null) throw new Exception("Ongeldig verzoek.");
      if (q.ContainsKey("id")) id = q["id"];
      var r = Run(q);
      r["id"] = id;
      return Js.Serialize(r);
    } catch (Exception e) {
      var d = new Dictionary<string, object>(); d["id"] = id; d["error"] = e.GetType().Name + ": " + e.Message; return Js.Serialize(d);
    }
  }

  static string S(Dictionary<string, object> q, string k) { object v; return q.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
  static int I(Dictionary<string, object> q, string k, int def) { object v; return q.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : def; }
  static Dictionary<string, object> Ok() { var d = new Dictionary<string, object>(); d["ok"] = true; return d; }
  static Dictionary<string, object> Refuse(string code, string msg) { var d = new Dictionary<string, object>(); d["ok"] = false; d["code"] = code; d["error"] = msg; return d; }

  static Dictionary<string, object> Run(Dictionary<string, object> q) {
    switch (S(q, "action")) {
      case "ping": { var d = Ok(); d["pid"] = Process.GetCurrentProcess().Id; d["elevated"] = selfElevated; return d; }
      case "held": { var d = Ok(); d["held"] = Held(I(q, "vk", 0)); return d; }
      case "probe": return Probe();
      case "paste": return Send(q, null);
      case "type": return Send(q, S(q, "text") ?? "");
    }
    throw new Exception("Onbekende actie");
  }

  static bool Held(int vk) { return vk > 0 && (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static string Proc(uint pid) {
    try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return ""; }
  }

  // Elevated (administrator) process: a normal process may not send it keys (UIPI drops them silently).
  static bool Elevated(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return false;
    try {
      IntPtr tok;
      if (!OpenProcessToken(p, 0x0008, out tok)) return true;
      try { int elev, ret; return GetTokenInformation(tok, 20, out elev, 4, out ret) && elev != 0; } finally { CloseHandle(tok); }
    } finally { CloseHandle(p); }
  }

  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj);

  // MSAA: Chromium-based apps (Chrome, Edge, Electron) always answer it and mark password inputs PROTECTED, also when
  // their UI Automation tree is not switched on.
  static bool MsaaPassword(IntPtr hwnd) {
    bool pw = false;
    var th = new Thread(() => {
      try {
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object o;
        if (AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref iid, out o) != 0 || o == null) return;
        var acc = o as Accessibility.IAccessible;
        for (int depth = 0; depth < 30 && acc != null; depth++) {
          object f = null;
          try { f = acc.accFocus; } catch { }
          if (f is Accessibility.IAccessible) { acc = (Accessibility.IAccessible)f; continue; }
          if (f == null) break;
          int child = f is int ? (int)f : 0;
          object st = null;
          try { st = acc.get_accState(child); } catch { }
          pw = st is int && (((int)st) & 0x20000000) != 0;
          break;
        }
      } catch { }
    });
    th.SetApartmentState(ApartmentState.STA);
    th.IsBackground = true;
    th.Start();
    th.Join(700);
    return pw;
  }

  static bool FocusPassword(IntPtr fg) {
    uint pid;
    uint tid = GetWindowThreadProcessId(fg, out pid);
    var gi = new GUITHREADINFO();
    gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    IntPtr focusHwnd = fg;
    if (GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus != IntPtr.Zero) {
      focusHwnd = gi.hwndFocus;
      var sb = new StringBuilder(128);
      GetClassName(gi.hwndFocus, sb, 128);
      if (Regex.IsMatch(sb.ToString(), "(^|\\.)(EDIT|RichEdit\\w*)(\\.|$)", RegexOptions.IgnoreCase) && (GetWindowLong(gi.hwndFocus, -16) & 0x20) != 0) return true;
    }
    // Browsers, WPF, UWP: UI Automation knows (within a time budget; a hanging app must not block dictation).
    bool pw = false;
    string focus = "";
    var th = new Thread(() => { try { var el = AutomationElement.FocusedElement; if (el != null) { var c = el.Current; pw = c.IsPassword; focus = c.ControlType == null ? "" : c.ControlType.ProgrammaticName.Replace("ControlType.", ""); } } catch { } });
    th.IsBackground = true;
    th.Start();
    th.Join(800);
    lastFocus = focus;
    if (pw) return true;
    if (MsaaPassword(focusHwnd)) { lastFocus = focus + "+msaa"; return true; }
    return false;
  }

  static Dictionary<string, object> Probe() {
    IntPtr fg = GetForegroundWindow();
    uint pid;
    GetWindowThreadProcessId(fg, out pid);
    string p = Proc(pid);
    var d = Ok();
    d["pid"] = (int)pid;
    d["process"] = p;
    d["blocked"] = Array.IndexOf(Blocked, p) >= 0;
    d["elevated"] = !selfElevated && pid != 0 && Elevated(pid);
    d["password"] = fg != IntPtr.Zero && FocusPassword(fg);
    d["focus"] = lastFocus;
    return d;
  }

  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Keys(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }

  static Dictionary<string, object> Send(Dictionary<string, object> q, string text) {
    // 1. Wait until the hotkey is let go: Ctrl+V must not become Ctrl+Alt+V.
    var keys = new List<int> { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    object ko;
    if (q.TryGetValue("keys", out ko) && ko is IEnumerable && !(ko is string)) foreach (var k in (IEnumerable)ko) keys.Add(Convert.ToInt32(k));
    var sw = Stopwatch.StartNew();
    int wait = I(q, "waitMs", 2500);
    while (keys.Exists(Held)) {
      if (sw.ElapsedMilliseconds > wait) return Refuse("keys", "De sneltoets werd niet losgelaten.");
      Thread.Sleep(15);
    }
    Thread.Sleep(30);
    // 2. Where would the keys go? Checked right before sending.
    IntPtr fg = GetForegroundWindow();
    uint pid;
    GetWindowThreadProcessId(fg, out pid);
    if (fg == IntPtr.Zero) return Refuse("changed", "Geen venster met de focus.");
    int expect = I(q, "expectPid", 0);
    if (expect != 0 && expect != (int)pid) return Refuse("changed", "Een ander programma heeft de focus.");
    string p = Proc(pid);
    if (Array.IndexOf(Blocked, p) >= 0) return Refuse("blocked", "Windows-beveiligingsvenster.");
    if (!selfElevated && Elevated(pid)) return Refuse("elevated", "Programma draait als administrator.");
    if (FocusPassword(fg)) return Refuse("password", "Wachtwoordveld.");
    if (GetForegroundWindow() != fg) return Refuse("changed", "Het venster veranderde.");
    if (text == null) {
      Keys(new INPUT[] { K(0x11, 0, 0), K(0x56, 0, 0), K(0x56, 0, 2), K(0x11, 0, 2) });
    } else {
      for (int i = 0; i < text.Length; i += 40) {
        if (GetForegroundWindow() != fg) return Refuse("changed", "Het venster veranderde tijdens het typen.");
        var list = new List<INPUT>();
        foreach (char c in text.Substring(i, Math.Min(40, text.Length - i))) { list.Add(K(0, c, 0x0004)); list.Add(K(0, c, 0x0004 | 0x0002)); }
        Keys(list.ToArray());
        Thread.Sleep(5);
      }
    }
    var d = Ok();
    d["process"] = p;
    return d;
  }
}
'@
$dll = $env:TB_DICT_DLL
$loaded = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $loaded = $true } catch { } }
if (-not $loaded -and $dll) { try { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library; Add-Type -Path $dll; $loaded = $true } catch { } }
if (-not $loaded) { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs }
[TbDict]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $res = [TbDict]::Handle($line)
  [Console]::Out.WriteLine($res)
  [Console]::Out.Flush()
}
`;

const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

type Waiting = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** The helper process (Windows only). Requests are answered in order; a timeout or crash restarts it. */
export class DictationHelper {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buf = '';
  private seq = 0;
  private waiting = new Map<number, Waiting>();
  private readonly script: string;
  private readonly dll: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.script = path.join(dir, 'teambot-dictation.ps1');
    const hash = crypto.createHash('sha256').update(DICTATION_PS1).digest('hex').slice(0, 12);
    this.dll = path.join(dir, `teambot-dictation-${hash}.dll`);
    const want = '﻿' + DICTATION_PS1;
    const cur = fs.existsSync(this.script) ? fs.readFileSync(this.script, 'utf8') : '';
    if (cur !== want) fs.writeFileSync(this.script, want, 'utf8');
    try {
      for (const f of fs.readdirSync(dir)) if (/^teambot-dictation-[0-9a-f]{12}\.dll$/.test(f) && path.join(dir, f) !== this.dll) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* an old assembly may still be loaded; removed next time */
    }
  }

  static supported() {
    return process.platform === 'win32';
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const p = new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, TB_DICT_DLL: this.dll };
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      this.buf = '';
      let err = '';
      const timer = setTimeout(() => {
        reject(new Error('De dicteerhulp startte niet op tijd'));
        child.kill();
      }, 60_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (s: string) => {
        this.buf += s;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/^﻿/, '').trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let j: any;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j?.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const w = this.waiting.get(Number(j?.id));
          if (!w) continue;
          this.waiting.delete(Number(j.id));
          clearTimeout(w.timer);
          if (j.error && j.ok === undefined) w.reject(new Error(String(j.error)));
          else w.resolve(j);
        }
      });
      child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-2000)));
      const gone = (e: Error) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        reject(e);
        for (const [, w] of this.waiting) (clearTimeout(w.timer), w.reject(e));
        this.waiting.clear();
      };
      child.on('error', gone);
      child.on('close', () => gone(new Error('De dicteerhulp is gestopt' + (err.trim() ? `: ${err.trim().split('\n').slice(-2).join(' ').slice(0, 200)}` : ''))));
    });
    p.catch(() => {});
    this.ready = p;
    return p;
  }

  async call(action: string, input: Record<string, any> = {}, timeoutMs = 8000): Promise<any> {
    await this.start();
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) throw new Error('De dicteerhulp draait niet');
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('De dicteerhulp reageerde niet'));
        child.kill();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin!.write(asciiJson({ ...input, action, id }) + '\n');
    });
  }

  /** Is the key (virtual-key code) physically held down right now? */
  async held(vk: number): Promise<boolean> {
    return !!(await this.call('held', { vk }, 3000))?.held;
  }

  kill() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    try {
      c?.kill();
    } catch {
      /* already gone */
    }
  }
}
