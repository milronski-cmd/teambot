/**
 * Persistent PowerShell helper for full-screen computer use on Windows ("Mijn bureaublad").
 *
 * One long-lived powershell.exe compiles the C# below once and then answers one JSON request per line on stdin with
 * one JSON line on stdout (requests are ASCII-only: Node escapes everything else as \uXXXX). This makes a
 * screenshot/click round trip ~0.1-0.4 s instead of 1-2 s for a fresh PowerShell + Add-Type per action.
 *
 * Safety lives here too, not only in Node: every request carries the bot's policy (allowed apps, always-blocked apps,
 * blocked title pattern, "whole screen" or "allowed apps only") and the driver re-checks, right before it sends any
 * input, that the window under the point (or the foreground window for keys) is allowed, not blocked and - when Node
 * passes `expect` - still the same window (handle + process id) that was checked and approved. Typing into a
 * password field is refused. Screenshots are composited in z-order so windows the bot may not see are painted over
 * before the image ever leaves this process; titles of hidden windows are never returned.
 *
 * `policy.owner` (remote desktop, server/modules/remote-desktop): the owner's own session from a phone or another PC.
 * Then Alt+Tab, Alt+F4, the Windows key and password fields are allowed (it is the owner typing), the messages speak
 * to the owner instead of about a bot, and the hard blocks still hold: TeamBot's own windows and Windows' security
 * prompts are masked and never receive remote input.
 *
 * Coordinates are physical screen pixels (the thread is per-monitor DPI aware v2), the virtual desktop may start at
 * negative coordinates on multi-monitor setups.
 */
export const SCREEN_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
try {
  Add-Type -AssemblyName UIAutomationClientsideProviders
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly([UIAutomationClientsideProviders.UIAutomationClientSideProviders].Assembly.GetName())
} catch { }
$refs = @(
  [System.Drawing.Bitmap].Assembly.Location,
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location,
  [System.Windows.Point].Assembly.Location
)
$src = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public class TbFail : Exception { public TbFail(string m) : base(m) { } }

public class TbWin {
  public long hwnd { get; set; }
  public int pid { get; set; }
  public string process { get; set; }
  public string title { get; set; }
  public string cls { get; set; }
  public int x { get; set; }
  public int y { get; set; }
  public int w { get; set; }
  public int h { get; set; }
  public bool minimized { get; set; }
  public bool visible { get; set; }
  public bool allowed { get; set; }
  public string blocked { get; set; }
  public bool overlay { get; set; }
  public bool foreground { get; set; }
}

public class TbMon {
  public int index { get; set; }
  public int x { get; set; }
  public int y { get; set; }
  public int w { get; set; }
  public int h { get; set; }
  public bool primary { get; set; }
  public int dpi { get; set; }
  public string device { get; set; }
}

public class TbPolicy {
  public HashSet<string> Allow = new HashSet<string>();
  public HashSet<string> Block = new HashSet<string>();
  public bool Full;
  public bool All;
  /** The owner's own remote-desktop session (not a bot): Alt+Tab, the Windows key and password fields are allowed. */
  public bool Owner;
  public Regex Title;
  public string BlockedReason(string proc, string title) {
    if (Block.Contains(proc)) return "beveiligd programma " + proc;
    string t = (title == null ? "" : title).ToLowerInvariant();
    if (t.Contains("teambot")) return "TeamBot zelf";
    if (Title != null && Title.IsMatch(t)) return "gevoelige pagina of app";
    return null;
  }
}

public static class TbScreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public delegate bool MonProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr d);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc cb, IntPtr d);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr m, int type, out uint x, out uint y);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetCloaked(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

  static JavaScriptSerializer Js = new JavaScriptSerializer();
  static readonly string[] HardBlock = new string[] { "teambot", "electron", "consent", "credentialuibroker", "lockapp", "logonui", "useraccountcontrolsettings" };
  static string lastPattern = null;
  static Regex lastRegex = null;
  static Dictionary<uint, string> procCache = new Dictionary<uint, string>();
  static DateTime procCacheAt = DateTime.MinValue;

  public static void Init() {
    Js.MaxJsonLength = int.MaxValue;
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
  }

  public static string Handle(string line) {
    object id = null;
    try {
      var q = Js.DeserializeObject(line) as Dictionary<string, object>;
      if (q == null) throw new TbFail("Ongeldig verzoek.");
      if (q.ContainsKey("id")) id = q["id"];
      var r = Run(q);
      r["id"] = id;
      return Js.Serialize(r);
    } catch (TbFail f) {
      var d = new Dictionary<string, object>(); d["id"] = id; d["error"] = f.Message; return Js.Serialize(d);
    } catch (Exception e) {
      var d = new Dictionary<string, object>(); d["id"] = id; d["error"] = "Fout in de schermhulp: " + e.GetType().Name + ": " + e.Message; return Js.Serialize(d);
    }
  }

  static Dictionary<string, object> Run(Dictionary<string, object> q) {
    string a = S(q, "action");
    switch (a) {
      case "ping": { var d = Ok(); d["pid"] = Process.GetCurrentProcess().Id; return d; }
      case "monitors": { var d = Ok(); d["monitors"] = Mons(); d["virtual"] = Virt(); return d; }
      case "windows": return WindowsRes(Pol(q));
      case "shot": return Shot(q);
      case "probe": return Probe(q);
      case "elements": return Elements(q);
      case "cursor": { var d = Ok(); d["cursor"] = Cursor(); return d; }
      case "move": return MoveRes(q);
      case "click": return Click(q);
      case "drag": return Drag(q);
      case "scroll": return Scroll(q);
      case "type": return TypeRes(q);
      case "key": return KeyRes(q);
      case "focus": return FocusRes(q);
      case "launch": return Launch(q);
    }
    throw new TbFail("Onbekende actie: " + a);
  }

  // ---------------- helpers ----------------

  static Dictionary<string, object> Ok() { var d = new Dictionary<string, object>(); d["ok"] = true; return d; }
  static Dictionary<string, object> Pt(int x, int y) { var d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d; }
  static string S(Dictionary<string, object> q, string k) { object v; return q != null && q.TryGetValue(k, out v) && v != null ? Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) : ""; }
  static long L(Dictionary<string, object> q, string k, long def) {
    object v; if (q == null || !q.TryGetValue(k, out v) || v == null) return def;
    try { return Convert.ToInt64(Math.Round(Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture))); } catch { return def; }
  }
  static int I(Dictionary<string, object> q, string k, int def) { long v = L(q, k, def); return v > int.MaxValue || v < int.MinValue ? def : (int)v; }
  static bool B(Dictionary<string, object> q, string k) { object v; return q != null && q.TryGetValue(k, out v) && v is bool && (bool)v; }
  static Dictionary<string, object> D(Dictionary<string, object> q, string k) { object v; return q != null && q.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
  static object[] A(Dictionary<string, object> q, string k) {
    object v; if (q == null || !q.TryGetValue(k, out v) || v == null) return new object[0];
    var arr = v as object[]; if (arr != null) return arr;
    var al = v as ArrayList; return al != null ? al.ToArray() : new object[0];
  }
  static string Trunc(string s, int n) { if (s == null) return ""; return s.Length > n ? s.Substring(0, n) : s; }
  public static string Norm(string s) {
    string t = (s == null ? "" : s).Trim().ToLowerInvariant();
    if (t.EndsWith(".exe")) t = t.Substring(0, t.Length - 4);
    t = Regex.Replace(t, "[^a-z0-9_.\\- ]", "");
    return t.Length > 60 ? t.Substring(0, 60) : t;
  }

  static TbPolicy Pol(Dictionary<string, object> q) {
    var d = D(q, "policy");
    if (d == null) throw new TbFail("Geen beleid meegegeven; actie geweigerd.");
    var p = new TbPolicy();
    foreach (var x in A(d, "allow")) p.Allow.Add(Norm(Convert.ToString(x)));
    foreach (var x in A(d, "block")) p.Block.Add(Norm(Convert.ToString(x)));
    foreach (var x in HardBlock) p.Block.Add(x);
    foreach (var x in HardBlock) p.Allow.Remove(x);
    p.Full = B(d, "full");
    p.All = B(d, "all");
    p.Owner = B(d, "owner");
    string t = S(d, "blockTitle");
    if (t.Length > 0) {
      if (t != lastPattern) { lastRegex = new Regex(t, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant); lastPattern = t; }
      p.Title = lastRegex;
    }
    return p;
  }

  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  static string ProcName(uint pid, bool fresh) {
    if ((DateTime.UtcNow - procCacheAt).TotalSeconds > 5) { procCache.Clear(); procCacheAt = DateTime.UtcNow; }
    string n;
    if (!fresh && procCache.TryGetValue(pid, out n)) return n;
    try { n = Norm(Process.GetProcessById((int)pid).ProcessName); } catch { n = ""; }
    procCache[pid] = n;
    return n;
  }
  /** UWP apps live in ApplicationFrameHost: use the process of the hosted CoreWindow. */
  static uint RealPid(IntPtr h, uint pid, string proc) {
    if (proc != "applicationframehost") return pid;
    uint found = 0;
    EnumChildWindows(h, (c, x) => { uint cp = PidOf(c); if (cp != 0 && cp != pid) { found = cp; return false; } return true; }, IntPtr.Zero);
    return found != 0 ? found : pid;
  }
  static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
  static bool Cloaked(IntPtr h) { int v = 0; try { DwmGetCloaked(h, 14, out v, 4); } catch { } return v != 0; }
  static bool IsOverlay(IntPtr h) { int ex = GetWindowLong(h, -20); return (ex & 0x20) != 0 && (ex & 0x80000) != 0; }
  /** Full-screen layered tool windows without a title (game/recording overlays) are not real windows. */
  static bool IsGhost(IntPtr h, RECT r, string title) {
    int ex = GetWindowLong(h, -20);
    if ((ex & 0x80000) == 0 || (ex & 0x80) == 0 || title.Length > 0) return false;
    long area = (long)(r.R - r.L) * (r.B - r.T);
    long vs = (long)GetSystemMetrics(0) * GetSystemMetrics(1);
    return vs > 0 && area * 10 >= vs * 9;
  }

  static TbWin Info(IntPtr h, TbPolicy p, bool fresh) {
    var w = new TbWin();
    w.hwnd = h.ToInt64();
    uint pid = PidOf(h);
    string proc = ProcName(pid, fresh);
    uint real = RealPid(h, pid, proc);
    if (real != pid) { pid = real; proc = ProcName(pid, fresh); }
    w.pid = (int)pid;
    w.process = proc;
    w.title = Title(h);
    w.cls = ClassOf(h);
    RECT r = Bounds(h);
    w.x = r.L; w.y = r.T; w.w = r.R - r.L; w.h = r.B - r.T;
    w.minimized = IsIconic(h);
    w.overlay = IsOverlay(h) || IsGhost(h, r, w.title);
    w.foreground = GetForegroundWindow() == h;
    if (p != null) {
      w.blocked = p.BlockedReason(w.process, w.title);
      w.allowed = w.blocked == null && w.process.Length > 0 && (p.All || p.Allow.Contains(w.process));
      w.visible = w.blocked == null && (p.Full || w.allowed);
    }
    return w;
  }
  /** What may leave this process about a window the bot may not see: nothing but its rectangle. */
  static TbWin Redact(TbWin w) {
    if (w == null || w.visible) return w;
    w.title = ""; w.cls = ""; if (w.blocked == null) w.blocked = null; else w.blocked = "geblokkeerd";
    return w;
  }

  static List<IntPtr> Top() {
    var l = new List<IntPtr>();
    EnumWindows((h, x) => { if (IsWindowVisible(h) && !Cloaked(h)) l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }

  static IntPtr RootAt(int x, int y) {
    POINT pt; pt.X = x; pt.Y = y;
    IntPtr h = WindowFromPoint(pt);
    if (h != IntPtr.Zero) h = GetAncestor(h, 2);
    if (h != IntPtr.Zero && !IsOverlay(h)) return h;
    foreach (var t in Top()) {
      if (IsIconic(t) || IsOverlay(t)) continue;
      RECT r = Bounds(t);
      if (x >= r.L && x < r.R && y >= r.T && y < r.B && !IsGhost(t, r, Title(t))) return t;
    }
    return IntPtr.Zero;
  }

  static Dictionary<string, object> Virt() {
    var d = new Dictionary<string, object>();
    d["x"] = GetSystemMetrics(76); d["y"] = GetSystemMetrics(77); d["w"] = GetSystemMetrics(78); d["h"] = GetSystemMetrics(79);
    return d;
  }
  static bool OnScreen(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    return x >= vx && y >= vy && x < vx + vw && y < vy + vh;
  }

  static List<TbMon> Mons() {
    var l = new List<TbMon>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr dc, ref RECT rc, IntPtr d) => {
      var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      GetMonitorInfo(m, ref mi);
      var o = new TbMon();
      o.x = mi.rcMonitor.L; o.y = mi.rcMonitor.T; o.w = mi.rcMonitor.R - mi.rcMonitor.L; o.h = mi.rcMonitor.B - mi.rcMonitor.T;
      o.primary = (mi.dwFlags & 1) != 0; o.device = mi.szDevice;
      uint dx = 96, dy = 96;
      try { GetDpiForMonitor(m, 0, out dx, out dy); } catch { }
      o.dpi = (int)dx;
      l.Add(o);
      return true;
    }, IntPtr.Zero);
    l.Sort((a, b) => a.primary != b.primary ? (a.primary ? -1 : 1) : (a.x != b.x ? a.x.CompareTo(b.x) : a.y.CompareTo(b.y)));
    for (int i = 0; i < l.Count; i++) l[i].index = i;
    return l;
  }

  static Dictionary<string, object> Cursor() { POINT c; GetCursorPos(out c); return Pt(c.X, c.Y); }

  static Dictionary<string, object> WindowsRes(TbPolicy p) {
    var list = new List<TbWin>();
    int hidden = 0;
    foreach (var h in Top()) {
      var w = Info(h, p, false);
      if (w.overlay || w.w <= 0 || w.h <= 0) continue;
      if (!w.visible) { hidden++; continue; }
      if (w.title.Length == 0 && !w.foreground) continue;
      list.Add(w);
    }
    var d = Ok(); d["windows"] = list; d["hidden"] = hidden; return d;
  }

  // ---------------- capture ----------------

  static readonly Color MaskColor = Color.FromArgb(38, 38, 44);

  static Bitmap Grab(int x, int y, int w, int h) {
    var b = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    try {
      using (var g = Graphics.FromImage(b)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
    } catch (Exception) {
      b.Dispose();
      throw new TbFail("Kon het scherm niet vastleggen (is de computer vergrendeld?).");
    }
    return b;
  }

  static List<Rectangle> PasswordRects(IntPtr h, int budgetMs) {
    var found = new List<Rectangle>();
    var th = new Thread(() => {
      try {
        var root = AutomationElement.FromHandle(h);
        var cond = new PropertyCondition(AutomationElement.IsPasswordProperty, true);
        var all = root.FindAll(TreeScope.Descendants, cond);
        lock (found) { foreach (AutomationElement e in all) { var r = e.Current.BoundingRectangle; if (!r.IsEmpty) found.Add(new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height)); } }
      } catch { }
    });
    th.IsBackground = true;
    th.Start();
    th.Join(budgetMs);
    lock (found) return new List<Rectangle>(found);
  }

  static Dictionary<string, object> Shot(Dictionary<string, object> q) {
    var p = Pol(q);
    var area = D(q, "area");
    if (area == null) throw new TbFail("Geen schermgebied.");
    int ax = I(area, "x", 0), ay = I(area, "y", 0), aw = I(area, "w", 0), ah = I(area, "h", 0);
    if (aw <= 0 || ah <= 0 || aw > 16384 || ah > 16384) throw new TbFail("Ongeldig schermgebied.");
    int ow = Math.Max(1, Math.Min(4096, I(q, "outW", aw))), oh = Math.Max(1, Math.Min(4096, I(q, "outH", ah)));
    string file = S(q, "out");
    if (file.Length == 0) throw new TbFail("Geen uitvoerbestand.");
    bool fast = B(q, "fast");
    var areaRect = new Rectangle(ax, ay, aw, ah);
    var shown = new List<TbWin>();
    int hidden = 0, pwMasked = 0;
    TbWin fg = null;
    using (var src = Grab(ax, ay, aw, ah))
    using (var comp = new Bitmap(aw, ah, PixelFormat.Format24bppRgb)) {
      var zs = new List<TbWin>();
      foreach (var h in Top()) {
        var w = Info(h, p, false);
        if (w.minimized || w.overlay || w.w <= 0 || w.h <= 0) continue;
        if (w.foreground) fg = w;
        if (!new Rectangle(w.x, w.y, w.w, w.h).IntersectsWith(areaRect)) continue;
        zs.Add(w);
      }
      using (var g = Graphics.FromImage(comp))
      using (var mask = new SolidBrush(MaskColor))
      using (var font = new Font("Segoe UI", 12, FontStyle.Regular, GraphicsUnit.Pixel))
      using (var ink = new SolidBrush(Color.FromArgb(140, 140, 150))) {
        if (p.Full) g.DrawImageUnscaled(src, 0, 0); else g.Clear(MaskColor);
        for (int i = zs.Count - 1; i >= 0; i--) {
          var w = zs[i];
          var rr = Rectangle.Intersect(new Rectangle(w.x - ax, w.y - ay, w.w, w.h), new Rectangle(0, 0, aw, ah));
          if (rr.Width <= 0 || rr.Height <= 0) continue;
          if (w.visible) g.DrawImage(src, rr, rr, GraphicsUnit.Pixel);
          else {
            g.FillRectangle(mask, rr);
            if (rr.Width > 140 && rr.Height > 30) g.DrawString(w.blocked != null ? "geblokkeerd" : "verborgen", font, ink, rr.X + 8, rr.Y + 6);
          }
        }
        foreach (var w in zs) { if (w.visible) shown.Add(w); else hidden++; }
        if (!fast && fg != null && fg.visible) {
          foreach (var r in PasswordRects(new IntPtr(fg.hwnd), 700)) {
            var rr = Rectangle.Intersect(new Rectangle(r.X - ax, r.Y - ay, r.Width, r.Height), new Rectangle(0, 0, aw, ah));
            if (rr.Width > 0 && rr.Height > 0) { g.FillRectangle(Brushes.Black, rr); pwMasked++; }
          }
        }
      }
      using (var outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb)) {
        using (var g = Graphics.FromImage(outBmp)) {
          if (ow == aw && oh == ah) g.DrawImageUnscaled(comp, 0, 0);
          else {
            g.InterpolationMode = fast ? InterpolationMode.Bilinear : InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            using (var ia = new ImageAttributes()) {
              ia.SetWrapMode(WrapMode.TileFlipXY);
              g.DrawImage(comp, new Rectangle(0, 0, ow, oh), 0, 0, aw, ah, GraphicsUnit.Pixel, ia);
            }
          }
          Marks(g, A(q, "marks"), ax, ay, (double)ow / aw, (double)oh / ah);
        }
        Save(outBmp, file, I(q, "quality", 80));
      }
    }
    var d = Ok();
    d["area"] = Pt(ax, ay); ((Dictionary<string, object>)d["area"])["w"] = aw; ((Dictionary<string, object>)d["area"])["h"] = ah;
    d["outW"] = ow; d["outH"] = oh;
    d["cursor"] = Cursor();
    d["foreground"] = Redact(fg);
    d["windows"] = shown;
    d["hidden"] = hidden;
    d["passwordMasked"] = pwMasked;
    return d;
  }

  /** Red target marks for approval previews: [x, y] = point, [x1, y1, x2, y2] = drag (screen pixels). */
  static void Marks(Graphics g, object[] marks, int ax, int ay, double sx, double sy) {
    if (marks.Length == 0) return;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    using (var pen = new Pen(Color.FromArgb(230, 220, 38, 38), 3))
    using (var thin = new Pen(Color.FromArgb(230, 220, 38, 38), 1.5f)) {
      foreach (var m in marks) {
        var arr = m as object[];
        if (arr == null) { var al = m as ArrayList; if (al != null) arr = al.ToArray(); }
        if (arr == null || arr.Length < 2) continue;
        float x = (float)((Convert.ToDouble(arr[0]) - ax) * sx), y = (float)((Convert.ToDouble(arr[1]) - ay) * sy);
        g.DrawEllipse(pen, x - 14, y - 14, 28, 28);
        g.DrawLine(thin, x - 22, y, x - 6, y); g.DrawLine(thin, x + 6, y, x + 22, y);
        g.DrawLine(thin, x, y - 22, x, y - 6); g.DrawLine(thin, x, y + 6, x, y + 22);
        if (arr.Length >= 4) {
          float x2 = (float)((Convert.ToDouble(arr[2]) - ax) * sx), y2 = (float)((Convert.ToDouble(arr[3]) - ay) * sy);
          using (var arrow = new Pen(Color.FromArgb(230, 220, 38, 38), 3)) {
            arrow.CustomEndCap = new AdjustableArrowCap(5, 5);
            g.DrawLine(arrow, x, y, x2, y2);
          }
          g.DrawEllipse(pen, x2 - 10, y2 - 10, 20, 20);
        }
      }
    }
  }

  static void Save(Bitmap b, string file, int quality) {
    if (file.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) { b.Save(file, ImageFormat.Png); return; }
    ImageCodecInfo jpg = null;
    foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpg = c;
    using (var ep = new EncoderParameters(1)) {
      ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(20, Math.Min(95, quality)));
      b.Save(file, jpg, ep);
    }
  }

  // ---------------- UI Automation ----------------

  static Dictionary<string, object> El(AutomationElement el, bool withDialog) {
    if (el == null) return null;
    var c = el.Current;
    var d = new Dictionary<string, object>();
    d["type"] = c.ControlType == null ? "" : c.ControlType.ProgrammaticName.Replace("ControlType.", "");
    d["name"] = Trunc(c.Name, 200);
    d["id"] = Trunc(c.AutomationId, 100);
    d["cls"] = Trunc(c.ClassName, 100);
    d["enabled"] = c.IsEnabled;
    bool pw = c.IsPassword;
    if (!pw) {
      string cls = c.ClassName == null ? "" : c.ClassName;
      if (Regex.IsMatch(cls, "(^|\\.)(EDIT|RichEdit\\w*)(\\.|$)", RegexOptions.IgnoreCase) && c.NativeWindowHandle != 0 && (GetWindowLong(new IntPtr(c.NativeWindowHandle), -16) & 0x20) != 0) pw = true;
    }
    d["password"] = pw;
    var r = c.BoundingRectangle;
    if (!r.IsEmpty && !double.IsInfinity(r.X)) { d["x"] = (int)r.X; d["y"] = (int)r.Y; d["w"] = (int)r.Width; d["h"] = (int)r.Height; }
    if (withDialog) {
      try {
        var walker = TreeWalker.ControlViewWalker;
        var cur = walker.GetParent(el);
        int n = 0;
        while (cur != null && n < 12) {
          if (cur.Current.ControlType == ControlType.Window) { d["dialog"] = Trunc(cur.Current.Name, 200); break; }
          cur = walker.GetParent(cur);
          n++;
        }
      } catch { }
    }
    return d;
  }

  static Dictionary<string, object> WithBudget(Func<Dictionary<string, object>> f, int ms) {
    Dictionary<string, object> res = null;
    var th = new Thread(() => { try { res = f(); } catch { res = null; } });
    th.IsBackground = true;
    th.Start();
    th.Join(ms);
    return res;
  }

  static Dictionary<string, object> ElementAt(int x, int y) {
    return WithBudget(() => El(AutomationElement.FromPoint(new System.Windows.Point(x, y)), true), 1500);
  }
  static Dictionary<string, object> FocusedEl() {
    return WithBudget(() => El(AutomationElement.FocusedElement, false), 1500);
  }

  static Dictionary<string, object> Probe(Dictionary<string, object> q) {
    var p = Pol(q);
    var d = Ok();
    d["cursor"] = Cursor();
    IntPtr fgh = GetForegroundWindow();
    TbWin fg = fgh != IntPtr.Zero ? Info(fgh, p, true) : null;
    if (q.ContainsKey("x") && q.ContainsKey("y")) {
      int x = I(q, "x", 0), y = I(q, "y", 0);
      d["onScreen"] = OnScreen(x, y);
      IntPtr h = OnScreen(x, y) ? RootAt(x, y) : IntPtr.Zero;
      TbWin w = h != IntPtr.Zero ? Info(h, p, true) : null;
      if (w != null && w.allowed && B(q, "element")) d["element"] = ElementAt(x, y);
      d["window"] = Redact(w);
    }
    if (B(q, "focus") && fg != null && fg.allowed) d["focused"] = FocusedEl();
    d["foreground"] = Redact(fg);
    return d;
  }

  static readonly HashSet<string> Interactive = new HashSet<string>(new string[] { "Button", "Edit", "MenuItem", "ListItem", "CheckBox", "RadioButton", "Hyperlink", "TabItem", "ComboBox", "TreeItem", "SplitButton", "Slider", "Spinner", "DataItem", "Document", "MenuBar", "Menu" });

  static Dictionary<string, object> Elements(Dictionary<string, object> q) {
    var p = Pol(q);
    IntPtr h = new IntPtr(L(q, "hwnd", 0));
    if (h == IntPtr.Zero || !IsWindow(h)) throw new TbFail("Het venster bestaat niet meer.");
    var w = Info(h, p, true);
    if (!w.allowed) throw new TbFail("Dit venster mag niet gelezen worden.");
    int max = Math.Max(1, Math.Min(200, I(q, "max", 80)));
    var list = new List<Dictionary<string, object>>();
    var th = new Thread(() => {
      try {
        var root = AutomationElement.FromHandle(h);
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<KeyValuePair<AutomationElement, int>>();
        stack.Push(new KeyValuePair<AutomationElement, int>(root, 0));
        int seen = 0;
        while (stack.Count > 0 && seen < 1500) {
          var pair = stack.Pop(); var el = pair.Key; int depth = pair.Value; seen++;
          try {
            if (depth > 0) {
              var c = el.Current;
              string type = c.ControlType == null ? "" : c.ControlType.ProgrammaticName.Replace("ControlType.", "");
              if (!c.IsOffscreen && Interactive.Contains(type) && (c.Name.Length > 0 || type == "Edit")) {
                var e = El(el, false);
                if (e != null && e.ContainsKey("w")) { lock (list) { if (list.Count < max) list.Add(e); } }
              }
            }
            if (depth < 14) {
              var kids = new List<AutomationElement>();
              var k = walker.GetFirstChild(el);
              while (k != null && kids.Count < 150) { kids.Add(k); k = walker.GetNextSibling(k); }
              for (int j = kids.Count - 1; j >= 0; j--) stack.Push(new KeyValuePair<AutomationElement, int>(kids[j], depth + 1));
            }
          } catch { }
          lock (list) { if (list.Count >= max) break; }
        }
      } catch { }
    });
    th.IsBackground = true;
    th.Start();
    th.Join(Math.Max(300, Math.Min(5000, I(q, "budgetMs", 1800))));
    var d = Ok();
    lock (list) d["elements"] = new List<Dictionary<string, object>>(list);
    d["window"] = w;
    return d;
  }

  // ---------------- input ----------------

  static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint flags) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; return i; }
  static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0x2C || vk == 0xA3 || vk == 0xA5; }
  static INPUT K(ushort vk, bool up) {
    var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.dwFlags = (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u);
    return i;
  }
  static INPUT U(char c, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = 0; i.u.ki.wScan = c; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); return i; }

  static void MoveTo(int x, int y) {
    SetCursorPos(x, y);
    Send(new INPUT[] { M(0x0001) });
  }
  static void Glide(int x1, int y1, int x2, int y2, int steps) {
    for (int s = 1; s <= steps; s++) {
      MoveTo(x1 + (x2 - x1) * s / steps, y1 + (y2 - y1) * s / steps);
      Thread.Sleep(12);
    }
  }

  static ushort[] Vks(object[] list) {
    var l = new List<ushort>();
    foreach (var v in list) { int n = Convert.ToInt32(v); if (n > 0 && n < 256) l.Add((ushort)n); }
    return l.ToArray();
  }
  static void Down(ushort[] vks) { foreach (var v in vks) Send(new INPUT[] { K(v, false) }); }
  static void Up(ushort[] vks) { for (int i = vks.Length - 1; i >= 0; i--) Send(new INPUT[] { K(vks[i], true) }); }

  /** The window under the point must be allowed, not blocked and (when given) the one Node checked and the owner approved. */
  static TbWin Verify(int x, int y, Dictionary<string, object> expect, TbPolicy p) {
    if (!OnScreen(x, y)) throw new TbFail("Het punt ligt buiten het scherm.");
    IntPtr h = RootAt(x, y);
    if (h == IntPtr.Zero) throw new TbFail("Op dat punt staat geen venster.");
    var w = Info(h, p, true);
    if (w.blocked != null) throw new TbFail(p.Owner ? "Dit venster kun je op afstand niet bedienen (" + w.blocked + ")." : "Op dat punt staat een venster dat een bot nooit mag bedienen (" + w.blocked + ").");
    if (!w.allowed && p.Owner) throw new TbFail("Dit venster kun je op afstand niet bedienen.");
    if (!w.allowed) throw new TbFail("Op dat punt staat een programma dat niet op de lijst met toegestane apps staat" + (w.process.Length > 0 ? " (" + w.process + ")" : "") + ".");
    if (expect != null && L(expect, "hwnd", 0) != 0 && (w.hwnd != L(expect, "hwnd", 0) || w.pid != I(expect, "pid", -1)))
      throw new TbFail("Het scherm is veranderd sinds de controle (er staat nu een ander venster op dat punt). Maak een nieuwe schermafbeelding.");
    return w;
  }
  static TbWin ForegroundAllowed(TbPolicy p, Dictionary<string, object> expect) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) throw new TbFail("Er is geen actief venster.");
    var w = Info(h, p, true);
    if (w.blocked != null) throw new TbFail(p.Owner ? "Het actieve venster kun je op afstand niet bedienen (" + w.blocked + "). Tik eerst in een ander venster." : "Het actieve venster mag een bot nooit bedienen (" + w.blocked + ").");
    if (!w.allowed && p.Owner) throw new TbFail("Het actieve venster kun je op afstand niet bedienen. Tik eerst in een ander venster.");
    if (!w.allowed) throw new TbFail("Het actieve venster hoort bij een programma dat niet op de lijst met toegestane apps staat" + (w.process.Length > 0 ? " (" + w.process + ")" : "") + ". Klik eerst in een toegestaan venster.");
    if (expect != null && L(expect, "hwnd", 0) != 0 && (w.hwnd != L(expect, "hwnd", 0) || w.pid != I(expect, "pid", -1)))
      throw new TbFail("Het actieve venster is veranderd sinds de controle. Maak een nieuwe schermafbeelding.");
    return w;
  }
  static Dictionary<string, object> Done(TbWin w) { var d = Ok(); d["cursor"] = Cursor(); if (w != null) d["window"] = w; return d; }

  static Dictionary<string, object> MoveRes(Dictionary<string, object> q) {
    int x = I(q, "x", int.MinValue), y = I(q, "y", int.MinValue);
    if (x == int.MinValue || y == int.MinValue || !OnScreen(x, y)) throw new TbFail("Het punt ligt buiten het scherm.");
    POINT c; GetCursorPos(out c);
    Glide(c.X, c.Y, x, y, 6);
    return Done(null);
  }

  static Dictionary<string, object> Click(Dictionary<string, object> q) {
    var p = Pol(q);
    int x = I(q, "x", int.MinValue), y = I(q, "y", int.MinValue);
    if (x == int.MinValue || y == int.MinValue) throw new TbFail("Geen punt opgegeven.");
    var expect = D(q, "expect");
    Verify(x, y, expect, p);
    string btn = S(q, "button");
    int count = Math.Max(1, Math.Min(3, I(q, "count", 1)));
    var mods = Vks(A(q, "mods"));
    POINT c; GetCursorPos(out c);
    Glide(c.X, c.Y, x, y, 4);
    Thread.Sleep(25);
    var w = Verify(x, y, expect, p);
    uint down = btn == "right" ? 0x0008u : btn == "middle" ? 0x0020u : 0x0002u;
    uint up = btn == "right" ? 0x0010u : btn == "middle" ? 0x0040u : 0x0004u;
    Down(mods);
    for (int k = 0; k < count; k++) { Send(new INPUT[] { M(down), M(up) }); Thread.Sleep(45); }
    Up(mods);
    return Done(w);
  }

  static Dictionary<string, object> Drag(Dictionary<string, object> q) {
    var p = Pol(q);
    int x1 = I(q, "x", int.MinValue), y1 = I(q, "y", int.MinValue), x2 = I(q, "x2", int.MinValue), y2 = I(q, "y2", int.MinValue);
    if (x1 == int.MinValue || y1 == int.MinValue || x2 == int.MinValue || y2 == int.MinValue) throw new TbFail("Geef een begin- en eindpunt.");
    var w = Verify(x1, y1, D(q, "expect"), p);
    Verify(x2, y2, D(q, "expect2"), p);
    POINT c; GetCursorPos(out c);
    Glide(c.X, c.Y, x1, y1, 4);
    Thread.Sleep(30);
    Verify(x1, y1, D(q, "expect"), p);
    Send(new INPUT[] { M(0x0002) });
    Thread.Sleep(60);
    Glide(x1, y1, x2, y2, Math.Max(8, Math.Min(40, (Math.Abs(x2 - x1) + Math.Abs(y2 - y1)) / 25)));
    Thread.Sleep(60);
    Send(new INPUT[] { M(0x0004) });
    return Done(w);
  }

  static Dictionary<string, object> Scroll(Dictionary<string, object> q) {
    var p = Pol(q);
    int x = I(q, "x", int.MinValue), y = I(q, "y", int.MinValue);
    if (x == int.MinValue || y == int.MinValue) throw new TbFail("Geen punt opgegeven.");
    var w = Verify(x, y, D(q, "expect"), p);
    int dy = Math.Max(-30, Math.Min(30, I(q, "dy", 0))), dx = Math.Max(-30, Math.Min(30, I(q, "dx", 0)));
    var mods = Vks(A(q, "mods"));
    MoveTo(x, y);
    Thread.Sleep(20);
    Down(mods);
    for (int i = 0; i < Math.Abs(dy); i++) { var e = M(0x0800); e.u.mi.mouseData = unchecked((uint)(dy > 0 ? -120 : 120)); Send(new INPUT[] { e }); Thread.Sleep(15); }
    for (int i = 0; i < Math.Abs(dx); i++) { var e = M(0x1000); e.u.mi.mouseData = unchecked((uint)(dx > 0 ? 120 : -120)); Send(new INPUT[] { e }); Thread.Sleep(15); }
    Up(mods);
    return Done(w);
  }

  static bool FocusIsPassword() {
    var f = FocusedEl();
    return f != null && f.ContainsKey("password") && (bool)f["password"];
  }

  static Dictionary<string, object> TypeRes(Dictionary<string, object> q) {
    var p = Pol(q);
    var w = ForegroundAllowed(p, D(q, "expect"));
    if (!p.Owner && FocusIsPassword()) throw new TbFail("Het veld met de focus is een wachtwoordveld. Een bot typt nooit wachtwoorden; vraag de gebruiker dit zelf te doen (desktop_request_takeover).");
    string text = S(q, "text");
    int n = 0;
    foreach (char ch in text) {
      if (n > 0 && n % 40 == 0 && GetForegroundWindow().ToInt64() != w.hwnd) throw new TbFail("Het actieve venster veranderde tijdens het typen; gestopt na " + n + " tekens.");
      if (ch == '\r') { n++; continue; }
      if (ch == '\n') Send(new INPUT[] { K(0x0D, false), K(0x0D, true) });
      else if (ch == '\t') Send(new INPUT[] { K(0x09, false), K(0x09, true) });
      else Send(new INPUT[] { U(ch, false), U(ch, true) });
      n++;
      Thread.Sleep(6);
    }
    var d = Done(w); d["typed"] = n; return d;
  }

  static Dictionary<string, object> KeyRes(Dictionary<string, object> q) {
    var p = Pol(q);
    var w = ForegroundAllowed(p, D(q, "expect"));
    var combos = A(q, "combos");
    bool pw = !p.Owner && FocusIsPassword();
    foreach (var cobj in combos) {
      var arr = cobj as object[];
      if (arr == null) { var al = cobj as ArrayList; if (al != null) arr = al.ToArray(); }
      if (arr == null) continue;
      var vks = Vks(arr);
      if (vks.Length == 0) continue;
      var set = new HashSet<ushort>(vks);
      if (p.Owner) {
        // The owner at a distance may switch windows and open Start; Ctrl+Alt+Del/End cannot be sent (and is not needed).
        if (set.Contains(0x11) && set.Contains(0x12) && (set.Contains(0x2E) || set.Contains(0x23))) throw new TbFail("Ctrl+Alt+Del kan niet op afstand.");
      } else {
        if (set.Contains(0x5B) || set.Contains(0x5C)) throw new TbFail("De Windows-toets is niet toegestaan voor bots.");
        if (set.Contains(0x12) && (set.Contains(0x09) || set.Contains(0x73) || set.Contains(0x1B))) throw new TbFail("Alt+Tab, Alt+F4 en Alt+Esc zijn niet toegestaan voor bots.");
        if (set.Contains(0x11) && (set.Contains(0x1B) || (set.Contains(0x12) && (set.Contains(0x2E) || set.Contains(0x23))))) throw new TbFail("Deze toetscombinatie is niet toegestaan voor bots.");
      }
      if (pw) {
        ushort main = vks[vks.Length - 1];
        bool printable = (main >= 0x30 && main <= 0x5A) || main == 0x20 || (main >= 0x60 && main <= 0x6F) || (main >= 0xBA && main <= 0xDF);
        if (printable || (set.Contains(0x2D) && set.Contains(0x10))) throw new TbFail("Het veld met de focus is een wachtwoordveld; een bot vult daar niets in.");
      }
      if (GetForegroundWindow().ToInt64() != w.hwnd) throw new TbFail("Het actieve venster veranderde; gestopt.");
      Down(vks);
      Thread.Sleep(20);
      Up(vks);
      Thread.Sleep(35);
    }
    return Done(w);
  }

  static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(80); }
    if (GetForegroundWindow() == h) return true;
    uint dummy;
    uint fgt = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
    uint me = GetCurrentThreadId();
    bool attached = fgt != 0 && fgt != me && AttachThreadInput(me, fgt, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgt, false);
    if (GetForegroundWindow() != h) { SwitchToThisWindow(h, true); Thread.Sleep(80); }
    Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }

  static Dictionary<string, object> FocusRes(Dictionary<string, object> q) {
    var p = Pol(q);
    IntPtr h = new IntPtr(L(q, "hwnd", 0));
    if (h == IntPtr.Zero || !IsWindow(h)) throw new TbFail("Het venster bestaat niet meer.");
    var w = Info(h, p, true);
    if (I(q, "pid", -1) != w.pid) throw new TbFail("Het venster hoort niet meer bij hetzelfde programma; bekijk de vensters opnieuw.");
    if (w.blocked != null) throw new TbFail("Dit venster mag een bot nooit bedienen (" + w.blocked + ").");
    if (!w.allowed) throw new TbFail("Dit programma staat niet op de lijst met toegestane apps.");
    if (!Focus(h)) throw new TbFail("Kon het venster niet naar voren halen.");
    return Done(Info(h, p, true));
  }

  static string FindStartApp(string name) {
    try {
      var t = Type.GetTypeFromProgID("Shell.Application");
      object sh = Activator.CreateInstance(t);
      object folder = t.InvokeMember("NameSpace", BindingFlags.InvokeMethod, null, sh, new object[] { "shell:AppsFolder" });
      if (folder == null) return null;
      object items = folder.GetType().InvokeMember("Items", BindingFlags.InvokeMethod, null, folder, null);
      int count = (int)items.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, items, null);
      string want = Norm(name);
      for (int i = 0; i < count && i < 2000; i++) {
        object it = items.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, items, new object[] { i });
        if (it == null) continue;
        string nm = Norm(Convert.ToString(it.GetType().InvokeMember("Name", BindingFlags.GetProperty, null, it, null)));
        string path = Convert.ToString(it.GetType().InvokeMember("Path", BindingFlags.GetProperty, null, it, null));
        string exe = Norm(System.IO.Path.GetFileNameWithoutExtension(path == null ? "" : path.Split('!')[0]));
        if (nm == want || exe == want) return path;
      }
    } catch { }
    return null;
  }

  static Dictionary<string, object> Launch(Dictionary<string, object> q) {
    var p = Pol(q);
    string name = Norm(S(q, "name"));
    if (name.Length == 0 || !(p.All || p.Allow.Contains(name))) throw new TbFail("Dit programma staat niet op de lijst met toegestane apps.");
    if (p.BlockedReason(name, "") != null) throw new TbFail("Dit programma mag een bot nooit starten.");
    var before = new HashSet<long>();
    foreach (var h in Top()) before.Add(h.ToInt64());
    string how = null;
    try { var psi = new ProcessStartInfo(name); psi.UseShellExecute = true; Process.Start(psi); how = "programma"; } catch { }
    if (how == null) {
      string app = FindStartApp(name);
      if (app != null) { Process.Start("explorer.exe", "shell:AppsFolder\\" + app); how = "startmenu"; }
    }
    if (how == null) throw new TbFail("Kon '" + name + "' niet starten: niet gevonden als programma of in het Startmenu.");
    int wait = Math.Max(500, Math.Min(15000, I(q, "waitMs", 8000)));
    var sw = Stopwatch.StartNew();
    TbWin found = null;
    while (sw.ElapsedMilliseconds < wait && found == null) {
      Thread.Sleep(250);
      foreach (var h in Top()) {
        var w = Info(h, p, true);
        if (w.allowed && w.title.Length > 0 && !w.overlay && (w.process == name || !before.Contains(w.hwnd))) { found = w; break; }
      }
    }
    var d = Ok(); d["how"] = how; d["window"] = found; return d;
  }
}
'@
# Compile once and cache the assembly next to the script (the file name carries a hash of this source).
$dll = $env:TB_SCREEN_DLL
$loaded = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $loaded = $true } catch { } }
if (-not $loaded -and $dll) { try { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library; Add-Type -Path $dll; $loaded = $true } catch { } }
if (-not $loaded) { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs }
[TbScreen]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $res = [TbScreen]::Handle($line)
  [Console]::Out.WriteLine($res)
  [Console]::Out.Flush()
}
`;
