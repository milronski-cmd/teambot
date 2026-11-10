// The uninstaller question about the data (D-02, build/installer.nsh). An installer or uninstaller may never run on a
// dev pc (a real TeamBot with the same app id lives there), so this test reads the NSIS include and plays its two
// macros with a tiny interpreter for the NSIS/LogicLib subset they use, the way electron-builder's uninstaller calls
// them (templates/nsis/uninstaller.nsh): un.onInit parses /S, a one-click uninstaller confirms and then makes itself
// silent, customUnInit runs at the end of un.onInit, customUnInstall at the start of the (silent) uninstall section.
// Played: started from Settings › Apps (Yes/No/Enter), a quiet uninstall (/S), an update and the way back
// (/S --updated), --delete-app-data, per user and an old per-machine install, one-click and assisted. It also checks the
// language strings against the languages electron-builder loads (one missing or extra and makensis stops the build).
// The live test needs a clean VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Lines without comments and blank lines (NSIS comments start with ; or #; none of our strings contain them). */
const code = nsh
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith(';') && !l.startsWith('#'));

function macroBody(name: string): string[] {
  const start = code.findIndex((l) => new RegExp(`^!macro ${name}\\b`).test(l));
  assert.ok(start >= 0, `macro ${name} exists`);
  const end = code.indexOf('!macroend', start);
  assert.ok(end > start, `macro ${name} is closed`);
  return code.slice(start + 1, end);
}

const defines = new Map<string, string>();
for (const l of code) {
  const m = /^!define (\w+) "(.*)"$/.exec(l);
  if (m) defines.set(m[1], m[2]);
}
const expand = (s: string): string => s.replace(/\$\{(\w+)\}/g, (all, name) => (defines.has(name) ? expand(defines.get(name)!) : all));

// ---------- the interpreter ----------
type Answer = 'yes' | 'no' | 'enter';
interface Run {
  /** The uninstaller's command line (UninstallString = "/currentuser", QuietUninstallString adds /S). */
  params?: string;
  /** package.json build.nsis.oneClick (defines ONE_CLICK). */
  oneClick?: boolean;
  installMode?: 'CurrentUser' | 'all';
  answer?: Answer;
  dataExists?: boolean;
  /** RMDir leaves files behind (a file still in use). */
  deleteFails?: boolean;
}
interface Outcome {
  /** Message boxes a person saw (a box answered by /SD in silent mode is not seen). */
  shown: { text: string; context: string }[];
  deleted: string[];
  context: string;
  log: string[];
  /** Programs run with nsExec::Exec (the watchdog task). */
  exec: string[];
}
/** The Windows account the (un)installer runs as. */
const WINDOWS_ENV: Record<string, string> = { USERDOMAIN: 'PC-SANNE', USERNAME: 'sanne' };
const USER_APPDATA = 'C:\\Users\\u\\AppData\\Roaming';
const ALL_APPDATA = 'C:\\ProgramData';
const FROM_SETTINGS = '/currentuser';
const QUIET = '/currentuser /S';
const UPDATE = '/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=C:\\Users\\u\\AppData\\Local\\Programs\\TeamBot';

/** electron-builder's GetOptions "/S": options split on "/", case-insensitive. */
const hasOption = (params: string, opt: string) => params.split('/').slice(1).some((p) => p.split(/\s/)[0].toUpperCase() === opt.toUpperCase());
const hasFlag = (params: string, flag: string) => params.split(/\s+/).some((p) => p === `--${flag}` || p === `/${flag}`);

function play(run: Run): Outcome {
  const r = { params: FROM_SETTINGS, oneClick: pkg.build.nsis.oneClick !== false, installMode: 'CurrentUser', answer: 'no' as Answer, dataExists: true, deleteFails: false, ...run };
  const data = `${USER_APPDATA}\\TeamBot`;
  const gone = new Set<string>();
  const vars = new Map<string, string>();
  const stack: string[] = [];
  const nsisDefines = new Set(['BUILD_UNINSTALLER', ...(r.oneClick ? ['ONE_CLICK'] : [])]);
  let errors = false;
  // un.onInit before customUnInit: /S makes it silent; a one-click uninstaller asks "Weet je zeker…?" (answered OK
  // here) and then makes itself silent too. initMultiUser: per machine = "all" context, per user = "current".
  let silent = hasOption(r.params, 'S') || r.oneClick;
  const out: Outcome = { shown: [], deleted: [], context: r.installMode === 'all' ? 'all' : 'current', log: [], exec: [] };
  const resolve = (p: string) =>
    expand(p)
      .replace(/^"|"$/g, '')
      .replace(/^\$APPDATA/, out.context === 'current' ? USER_APPDATA : ALL_APPDATA)
      .replace(/\\\*\.\*$/, '');
  const value = (s: string) => s.replace(/^"|"$/g, '').replace(/\$(\w+)/g, (all, n) => vars.get(n) ?? all);

  function messageBox(spec: string, onlyOnYes: boolean): boolean {
    const m = /^MessageBox ([A-Z0-9_|]+) "([^"]*)"(?: \/SD (ID[A-Z]+))?(?: (ID[A-Z]+))?$/.exec(spec.trim());
    assert.ok(m, `MessageBox understood: ${spec}`);
    const [, flags, text, sd, check] = m;
    // NSIS: in silent mode a box with /SD answers itself; without /SD it is shown anyway.
    if (silent && sd) return onlyOnYes && sd === check;
    out.shown.push({ text, context: out.context });
    if (!onlyOnYes) return false;
    assert.ok(/MB_YESNO/.test(flags), 'a Yes/No question');
    const def = /MB_DEFBUTTON2/.test(flags) ? 'IDNO' : 'IDYES';
    const pressed = r.answer === 'enter' ? def : r.answer === 'yes' ? 'IDYES' : 'IDNO';
    return pressed === check;
  }
  function cond(c: string): boolean {
    let m: RegExpExecArray | null;
    if (c === '${isUpdated}') return hasFlag(r.params, 'updated');
    if (c === '${isDeleteAppData}') return hasFlag(r.params, 'delete-app-data');
    if (c === '${Silent}') return silent;
    if (c === '${Errors}') {
      const e = errors;
      errors = false; // IfErrors clears the flag
      return e;
    }
    if ((m = /^\$installMode == "(\w+)"$/.exec(c))) return r.installMode === m[1];
    if ((m = /^\$(\w+) == "(.*)"$/.exec(c))) return (vars.get(m[1]) ?? '') === m[2];
    if ((m = /^\$\{FileExists\} (".*")$/.exec(c))) {
      const p = resolve(m[1]);
      return r.dataExists && p === data && !gone.has(p);
    }
    if ((m = /^\$\{Cmd\} `(.*)`$/.exec(c))) return messageBox(m[1], true);
    throw new Error(`condition not understood: ${c}`);
  }

  function exec(lines: string[]) {
    const flow: { on: boolean; parentOn: boolean; done: boolean }[] = [];
    const pre: boolean[] = [];
    const active = () => pre.every(Boolean) && flow.every((f) => f.on);
    for (const line of lines) {
      let m: RegExpExecArray | null;
      // compile time
      if ((m = /^!(ifdef|ifndef) (\w+)$/.exec(line))) {
        pre.push(nsisDefines.has(m[2]) === (m[1] === 'ifdef'));
        continue;
      }
      if (line === '!else') {
        pre.push(!pre.pop());
        continue;
      }
      if (line === '!endif') {
        assert.ok(pre.pop() !== undefined, 'balanced !endif');
        continue;
      }
      // LogicLib
      if ((m = /^\$\{(If|IfNot)\} (.*)$/.exec(line))) {
        const parentOn = active();
        const v = parentOn ? cond(m[2]) !== (m[1] === 'IfNot') : false;
        flow.push({ on: v, parentOn, done: v });
      } else if ((m = /^\$\{(AndIf|AndIfNot)\} (.*)$/.exec(line))) {
        const f = flow.at(-1)!;
        // LogicLib short-circuits: the next test only runs when the ones before were true.
        f.on = f.on && cond(m[2]) !== (m[1] === 'AndIfNot');
        f.done = f.on;
      } else if (line === '${Else}') {
        const f = flow.at(-1)!;
        f.on = f.parentOn && !f.done;
        f.done = true;
      } else if (line === '${EndIf}') {
        assert.ok(flow.pop(), 'balanced ${EndIf}');
      } else if (!active()) {
        continue;
      } else if ((m = /^SetShellVarContext (current|all)$/.exec(line))) {
        out.context = m[1];
      } else if ((m = /^SetSilent (silent|normal)$/.exec(line))) {
        silent = m[1] === 'silent';
      } else if ((m = /^StrCpy \$(\w+) (".*")$/.exec(line))) {
        vars.set(m[1], value(m[2]));
      } else if ((m = /^Push \$(\w+)$/.exec(line))) {
        stack.push(vars.get(m[1]) ?? '');
      } else if ((m = /^Pop \$(\w+)$/.exec(line))) {
        assert.ok(stack.length, `Pop ${m[1]} has a matching Push`);
        vars.set(m[1], stack.pop()!);
      } else if ((m = /^\$\{GetParameters\} \$(\w+)$/.exec(line))) {
        vars.set(m[1], r.params);
      } else if (line === 'ClearErrors') {
        errors = false;
      } else if ((m = /^\$\{GetOptions\} \$(\w+) "([^"]+)" \$(\w+)$/.exec(line))) {
        const found = hasOption(vars.get(m[1]) ?? '', m[2].replace(/^\//, ''));
        if (!found) errors = true;
        vars.set(m[3], '');
      } else if ((m = /^RMDir \/r (".*")$/.exec(line))) {
        const p = resolve(m[1]);
        out.deleted.push(p);
        if (!r.deleteFails) gone.add(p);
      } else if (line.startsWith('MessageBox ')) {
        messageBox(line, false);
      } else if (line.startsWith('DetailPrint ')) {
        out.log.push(line);
      } else if ((m = /^ReadEnvStr \$(\w+) (\w+)$/.exec(line))) {
        vars.set(m[1], WINDOWS_ENV[m[2]] ?? '');
      } else if ((m = /^nsExec::Exec '(.*)'$/.exec(line))) {
        // nsExec leaves the exit code on the stack; $R8-style variables are filled in.
        out.exec.push(m[1].replace(/\$(R\d)/g, (_all, v: string) => vars.get(v) ?? ''));
        stack.push('0');
      } else {
        throw new Error(`statement not understood: ${line}`);
      }
    }
    assert.equal(flow.length, 0, 'every ${If} is closed');
    assert.equal(pre.length, 0, 'every !ifdef is closed');
  }

  exec(macroBody('customUnInit'));
  assert.equal(stack.length, 0, 'customUnInit leaves the stack as it found it');
  // un.onInit ends; the uninstall section runs (silent in a one-click uninstaller, as the silent flag is now).
  exec(macroBody('customUnInstall'));
  return out;
}

const DATA = `${USER_APPDATA}\\TeamBot`;
const QUESTION = '$(teambotDeleteData)';
const FAILED = '$(teambotDeleteDataFailed)';

// ---------- wiring ----------
test('installer: electron-builder includes the file and never deletes the data on its own', () => {
  const nsis = pkg.build.nsis;
  assert.equal(nsis.include, 'build/installer.nsh');
  assert.equal(nsis.deleteAppDataOnUninstall, false, 'otherwise electron-builder deletes without asking');
  assert.equal(nsis.oneClick, true, 'one-click: the question is asked in un.onInit (customUnInit), see the header');
  assert.equal(expand('${TEAMBOT_DATA_DIR}'), '$APPDATA\\TeamBot', 'the folder the app uses (server/core/config.ts)');
  // Exactly one place that deletes anything, and it is the data folder, in the uninstall section.
  const deletes = code.filter((l) => /^(RMDir|Delete)\b/i.test(l));
  assert.deepEqual(deletes, ['RMDir /r "${TEAMBOT_DATA_DIR}"']);
  assert.ok(macroBody('customUnInstall').includes(deletes[0]));
  assert.ok(!macroBody('customUnInit').includes(deletes[0]), 'un.onInit only asks');
});

test('installer: the variable exists only in the uninstaller build (an unused one stops makensis -WX)', () => {
  const at = code.indexOf('Var teambotRemoveData');
  assert.ok(at > 0, 'declared once, at the top level');
  assert.equal(code[at - 1], '!ifdef BUILD_UNINSTALLER');
  assert.equal(code[at + 1], '!endif');
  assert.equal(code.filter((l) => /^Var\b/.test(l)).length, 1);
  // Every SetSilent sits inside !ifdef ONE_CLICK: an assisted uninstaller must never become silent here.
  const init = macroBody('customUnInit');
  init.forEach((l, i) => {
    if (l.startsWith('SetSilent')) assert.equal(init[i - 1], '!ifdef ONE_CLICK', l);
  });
});

// ---------- started by a person (Settings › Apps, Start menu) ----------
test('uninstall: asks with No as the default and deletes only on Yes', () => {
  const yes = play({ answer: 'yes' });
  assert.deepEqual(yes.shown.map((s) => s.text), [QUESTION], 'the question is shown although the one-click uninstaller is silent');
  assert.deepEqual(yes.deleted, [DATA]);

  const no = play({ answer: 'no' });
  assert.deepEqual(no.shown.map((s) => s.text), [QUESTION]);
  assert.deepEqual(no.deleted, []);
  assert.ok(no.log.some((l) => l.includes('data kept')));

  const enter = play({ answer: 'enter' });
  assert.deepEqual(enter.shown.map((s) => s.text), [QUESTION]);
  assert.deepEqual(enter.deleted, [], 'Enter = the default button = No');

  const question = macroBody('customUnInit').find((l) => l.includes(QUESTION))!;
  assert.match(question, /MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/);
  assert.match(question, /\/SD IDNO IDYES`$/, 'silent answer is No; only Yes leads to deleting');
});

test('uninstall: the same with the assisted uninstaller (oneClick false), which is not silent by itself', () => {
  assert.deepEqual(play({ oneClick: false, answer: 'yes' }).deleted, [DATA]);
  assert.deepEqual(play({ oneClick: false, answer: 'no' }).deleted, []);
  assert.deepEqual(play({ oneClick: false, answer: 'enter' }).shown.map((s) => s.text), [QUESTION]);
});

test('uninstall: no data folder, no question', () => {
  const r = play({ dataExists: false, answer: 'yes' });
  assert.deepEqual(r.shown, []);
  assert.deepEqual(r.deleted, []);
});

test('uninstall: Yes but a file is still in use → says what is left and where (shown in the silent section)', () => {
  const r = play({ answer: 'yes', deleteFails: true });
  assert.deepEqual(r.shown.map((s) => s.text), [QUESTION, FAILED]);
  assert.deepEqual(r.deleted, [DATA]);
  assert.deepEqual(play({ answer: 'yes' }).shown.map((s) => s.text), [QUESTION], 'no second box when it worked');
});

// ---------- never on silent or update ----------
test('uninstall: a quiet uninstall, an update and the way back never ask and never delete', () => {
  for (const run of [
    { params: QUIET, answer: 'yes' as Answer }, // QuietUninstallString, scripts
    { params: '/S', answer: 'yes' as Answer },
    { params: '/currentuser /s', answer: 'yes' as Answer }, // GetOptions is case-insensitive
    { params: UPDATE, answer: 'yes' as Answer }, // the installer of a new version, electron-updater, "Terug naar versie x"
    { params: '/currentuser --updated', answer: 'yes' as Answer }, // --updated without /S
    { params: UPDATE, oneClick: false, answer: 'yes' as Answer },
    { params: QUIET, installMode: 'all' as const, answer: 'yes' as Answer },
    { params: UPDATE, installMode: 'all' as const, answer: 'yes' as Answer },
  ]) {
    const r = play(run);
    assert.deepEqual(r.shown, [], `nothing waits for a click: ${JSON.stringify(run)}`);
    assert.deepEqual(r.deleted, [], JSON.stringify(run));
  }
  // Two layers: the guards come first, and the question itself answers No when silent.
  const init = macroBody('customUnInit');
  const guard = init.indexOf('${If} ${Errors}');
  assert.ok(guard > 0 && init[guard - 1] === '${GetOptions} $R0 "/S" $R1');
  assert.deepEqual(init.slice(guard + 1, guard + 3), ['${AndIfNot} ${isUpdated}', '${AndIfNot} ${isDeleteAppData}']);
});

test('watchdog (0.4.4 P14): a task of the user himself every 10 minutes, no admin rights; uninstalling removes it, an update keeps it', async () => {
  const inst = macroBody('customInstall');
  const create = inst.find((l) => l.startsWith('nsExec::Exec'))!;
  for (const part of ['schtasks.exe /Create /F /SC MINUTE /MO 10', '/TN "TeamBot Wachter ($R8 $R9)"', '/TR "conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File', '\\"$INSTDIR\\resources\\watchdog.ps1\\""']) assert.ok(create.includes(part), part);
  // Per user, no admin rights, no UAC: no other account or password, no highest run level, no task folder (making
  // one can need admin rights).
  assert.ok(!/\/RU|\/RP|\/RL|SYSTEM/i.test(create), 'no other account and no admin rights');
  assert.ok(!/\/TN "[^"]*\\/.test(create), 'in the root folder');
  assert.deepEqual(inst.filter((l) => l.startsWith('ReadEnvStr')), ['ReadEnvStr $R8 USERDOMAIN', 'ReadEnvStr $R9 USERNAME']);
  assert.equal(inst.filter((l) => l.startsWith('Push ')).length, 3);
  assert.equal(inst.filter((l) => l.startsWith('Pop ')).length, 4, 'the three registers and the exit code of nsExec');
  assert.equal(pkg.build.nsis.perMachine, false, 'a per-user installer: never elevated');
  // The script ships in resources.
  assert.ok(pkg.build.extraResources.some((r: any) => r.from === 'build/watchdog.ps1' && r.to === 'watchdog.ps1'));
  assert.ok(fs.existsSync(path.join(root, 'build', 'watchdog.ps1')));
  // Uninstalling deletes exactly the task the installer made, for the account that uninstalls.
  const del = 'schtasks.exe /Delete /F /TN "TeamBot Wachter (PC-SANNE sanne)"';
  assert.deepEqual(play({ params: '', answer: 'no' }).exec, [del], 'a person uninstalls and keeps the data: the task goes');
  assert.deepEqual(play({ params: '', answer: 'yes' }).exec, [del], 'a person uninstalls with the data: the task goes');
  assert.deepEqual(play({ params: QUIET, answer: 'yes' }).exec, [del], 'a quiet uninstall: the task goes too');
  assert.deepEqual(play({ params: '/currentuser --delete-app-data', answer: 'no' }).exec, [del]);
  assert.deepEqual(play({ params: UPDATE, answer: 'yes' }).exec, [], 'an update keeps the task (the new installer makes it again)');
  assert.deepEqual(play({ params: UPDATE, installMode: 'all', answer: 'yes' }).exec, []);
  // The app's own check asks Windows for exactly this name.
  const { taskName } = await import('../server/modules/health/task.js');
  assert.equal(taskName({ USERDOMAIN: 'PC-SANNE', USERNAME: 'sanne' }), 'TeamBot Wachter (PC-SANNE sanne)');
});

test('watchdog (0.4.4 P14): before it closes TeamBot, the installer leaves "bewust gestopt", only when TeamBot has data', () => {
  const init = macroBody('customInit');
  assert.equal(init[0], '${If} ${FileExists} "${TEAMBOT_DATA_DIR}\\*.*"');
  assert.ok(init.includes('FileOpen $R7 "${TEAMBOT_DATA_DIR}\\health\\stopped.json" w'));
  assert.ok(init.includes(`FileWrite $R7 '{"reason":"installer"}'`));
  assert.equal(init.filter((l) => l === 'Push $R7').length, 1);
  assert.equal(init.filter((l) => l === 'Pop $R7').length, 1, 'leaves $R7 as it found it');
  assert.ok(nsh.includes('!define TEAMBOT_DATA_DIR "$APPDATA\\TeamBot"'), 'the data folder of this user');
});

test('uninstall: --delete-app-data keeps its electron-builder meaning (no extra question)', () => {
  const r = play({ params: '/currentuser --delete-app-data', answer: 'no' });
  assert.deepEqual(r.shown, []);
  assert.deepEqual(r.deleted, [], 'electron-builder itself deletes after the macro; ours stays out of it');
});

// ---------- an older TeamBot installed for all users ----------
test('uninstall for all users: asks about the user folder and switches the context back', () => {
  const yes = play({ installMode: 'all', answer: 'yes' });
  assert.equal(yes.shown.length, 1, 'found the data in the user folder, not in ProgramData');
  assert.equal(yes.shown[0].context, 'current', 'the path in the question is the user folder');
  assert.deepEqual(yes.deleted, [DATA]);
  assert.equal(yes.context, 'all', 'registry and start menu are removed in the context of the installation');

  const no = play({ installMode: 'all', answer: 'no' });
  assert.deepEqual(no.deleted, []);
  assert.equal(no.context, 'all');

  assert.equal(play({ answer: 'yes' }).context, 'current', 'per user stays per user');
});

// ---------- language strings ----------
test('uninstall texts: Dutch and English language strings for exactly the languages electron-builder loads', () => {
  const require = createRequire(import.meta.url);
  const langs = require('app-builder-lib/out/util/langs.js') as { bundledLanguages: string[]; lcid: Record<string, number>; toLangWithRegion: (l: string) => string };
  const configured: string[] | undefined = pkg.build.nsis.installerLanguages;
  assert.notEqual(pkg.build.nsis.multiLanguageInstaller, false, 'one language only would be en_US: no Dutch installer');
  const loaded = (configured ? configured.map((l) => langs.toLangWithRegion(l.replace('-', '_'))) : langs.bundledLanguages).map((l) => langs.lcid[l]);
  assert.ok(loaded.includes(1043) && loaded.includes(1033), 'Dutch and English are among them');

  const strings = new Map<string, Map<number, string>>();
  const add = (name: string, id: number, text: string) => {
    if (!strings.has(name)) strings.set(name, new Map());
    assert.equal(strings.get(name)!.has(id), false, `${name} set once for ${id}`);
    strings.get(name)!.set(id, expand(text));
  };
  const fallback = macroBody('teambotEnglishTexts');
  for (const l of code) {
    let m = /^LangString (\w+) (\d+) "(.*)"$/.exec(l);
    if (m) add(m[1], Number(m[2]), m[3]);
    m = /^!insertmacro teambotEnglishTexts (\d+)$/.exec(l);
    if (m)
      for (const f of fallback) {
        const x = /^LangString (\w+) \$\{LANG_ID\} "(.*)"$/.exec(f);
        assert.ok(x, `fallback line understood: ${f}`);
        add(x[1], Number(m[1]), x[2]);
      }
  }
  const all = [...new Set([...nsh.matchAll(/\$\((\w+)\)/g)].map((m) => m[1]))];
  const used = all.filter((n) => n.startsWith('teambot'));
  assert.deepEqual(used.sort(), ['teambotDeleteData', 'teambotDeleteDataFailed']);
  // electron-builder's own messages (in every language it loads) may be used as they are.
  const builtin = fs.readFileSync(require.resolve('app-builder-lib/templates/nsis/messages.yml'), 'utf8');
  for (const n of all.filter((x) => !x.startsWith('teambot'))) assert.match(builtin, new RegExp(`^${n}:`, 'm'), `${n} is one of electron-builder's messages`);
  for (const name of used) {
    const ids = [...strings.get(name)!.keys()].sort((a, b) => a - b);
    assert.deepEqual(ids, [...loaded].sort((a, b) => a - b), `${name}: a string for every loaded language and no other`);
  }

  const q = strings.get('teambotDeleteData')!;
  assert.match(q.get(1043)!, /^Ook je gegevens verwijderen \(bots, gesprekken, geheugen\)\?/);
  assert.match(q.get(1043)!, /Kies Nee om ze te bewaren/);
  assert.match(q.get(1033)!, /^Also delete your data \(bots, chats, memory\)\?/);
  assert.match(q.get(1033)!, /Choose No to keep it/);
  for (const [id, text] of q) if (id !== 1043) assert.equal(text, q.get(1033), `language ${id} gets the English text`);
  for (const text of q.values()) assert.ok(text.includes('$APPDATA\\TeamBot'), 'the question names the folder');
});
