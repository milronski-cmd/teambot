import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliDef } from './catalog.js';
import { parseVersion, runQuick } from './proc.js';
import { ACCOUNT_NOTE, claudeFeatures, ownerMemoryExcludes } from './claude.js';
import { lastOutput } from './context.js';
import { fatalStderrError } from './acp.js';

/**
 * One short answer from a CLI engine, without tools, session or workspace: for small jobs outside a chat such as
 * "maak een profiel" from a description. Runs in an empty temp folder; the CLI's own login decides billing.
 * Supported: Claude Code, Codex and OpenCode. Other CLIs return null (the caller says which engines work).
 */
export async function cliComplete(def: CliDef, bin: string, req: { model?: string; system: string; prompt: string; timeoutMs?: number }): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cli-complete-'));
  const model = req.model && req.model !== 'default' ? req.model : '';
  const timeoutMs = req.timeoutMs ?? 150_000;
  try {
    let args: string[];
    let outFile = '';
    let legacy: string[] | null = null;
    const env: Record<string, string> = {};
    if (def.engine === 'claude') {
      // Without the owner's own Claude Code context (settings, claude.ai skills, CLAUDE.md, auto-memory), as in bot runs.
      const f = await claudeFeatures(bin);
      args = ['-p', req.prompt, '--output-format', 'text', '--append-system-prompt', `${req.system}\n\n${ACCOUNT_NOTE}`, '--max-turns', '1', '--permission-mode', 'plan', '--strict-mcp-config'];
      if (f.settingSources) args.push('--setting-sources', 'project,local');
      if (f.settings) args.push('--settings', JSON.stringify({ claudeMdExcludes: ownerMemoryExcludes(dir, os.homedir()) }));
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      if (model) args.push('--model', model);
    } else if (def.engine === 'codex') {
      outFile = path.join(dir, 'answer.txt');
      args = ['exec', '--skip-git-repo-check', '--color', 'never', '-s', 'read-only', '-c', 'approval_policy="never"', '-o', outFile];
      if (model) args.push('-m', model);
      args.push(`${req.system}\n\n${req.prompt}`);
    } else if (def.id === 'opencode') {
      // OpenCode 2.x (TeamBot's own copy): --standalone, or it starts or joins a shared "managed service" on a fixed
      // port, which fails when another OpenCode (e.g. OpenBot's) holds that port. A failed model call (the free limit)
      // ends `run` within a second with "Error: …" on stderr (verified live with 2.2.6).
      // OpenCode 1.x does not know --standalone, and a failed model call is only logged while `run` waits forever
      // (1.19.5, live): its log on stderr (upper-case level, which 2.x refuses) lets TeamBot stop it and say why.
      const major = Number(parseVersion((await runQuick(bin, ['--version'], { timeoutMs: 15_000 })).stdout)?.split('.')[0]);
      const v2 = ['run', '--standalone', `${req.system}\n\n${req.prompt}`];
      const v1 = ['run', '--print-logs', '--log-level', 'ERROR', `${req.system}\n\n${req.prompt}`];
      args = major >= 2 || !major ? v2 : v1;
      if (model) args.push('-m', model);
      if (!major) legacy = model ? [...v1, '-m', model] : v1;
    } else return null;
    const stopOn = def.id === 'opencode' ? (e: string) => !!fatalStderrError(e) : undefined;
    let r = await runQuick(bin, args, { timeoutMs, cwd: dir, env, stopOn });
    // Version unknown and the flags were wrong: OpenCode prints an error or only its help for "run" (1.19.5:
    // "opencode run [message..]"): try the 1.x form.
    if (legacy && !r.stdout.trim() && /unknown (flag|option|argument)|unexpected (flag|argument)|--standalone|^\s*opencode run \[message/im.test(r.stderr)) {
      r = await runQuick(bin, legacy, { timeoutMs, cwd: dir, stopOn });
    }
    const fatal = stopOn ? fatalStderrError(r.stderr) : null;
    if (fatal) throw new Error(`${def.label} gaf een fout: ${fatal}`);
    const text = (outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : r.stdout).trim();
    if (!text) {
      // OpenCode 2.x: "Error: Free usage limit reached …" (with colour codes) on stderr and exit 1.
      const err = def.id === 'opencode' ? /(?:^|\s)Error:\s*(.+)$/m.exec(lastOutput(r.stderr, 400))?.[1]?.trim() : '';
      if (err) throw new Error(`${def.label} gaf een fout: ${err}`);
      throw new Error(`${def.label} gaf geen antwoord${r.error ? `: ${r.error}` : r.stderr.trim() ? `: ${lastOutput(r.stderr.trim().split('\n').pop() || '', 200)}` : ''}`);
    }
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
