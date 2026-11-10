import { useEffect, useMemo, useState } from 'react';

/**
 * Syntax colours for code blocks in the chat and for code files in a preview (A-35). highlight.js (BSD-3-Clause) is
 * loaded only when the first code block appears, as its own chunk. Its output is escaped HTML with class names only
 * (`hljs-keyword`, …); the colours come from styles.css and follow the light/dark theme. Large or unknown input stays
 * plain text, so a huge log never blocks the page.
 */
type Hljs = typeof import('highlight.js').default;

let loading: Promise<Hljs> | null = null;
let ready: Hljs | null = null;

export function loadHighlighter(): Promise<Hljs> {
  if (!loading)
    loading = Promise.all([import('highlight.js/lib/common'), import('highlight.js/lib/languages/powershell'), import('highlight.js/lib/languages/dockerfile')]).then(([common, ps, docker]) => {
      const h = common.default as Hljs;
      h.registerLanguage('powershell', ps.default);
      h.registerLanguage('dockerfile', docker.default);
      ready = h;
      return h;
    });
  return loading;
}

/** Fence tags and file extensions → highlight.js language names. */
const ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  py: 'python',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  psm1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  md: 'markdown',
  cs: 'csharp',
  rs: 'rust',
  kt: 'kotlin',
  rb: 'ruby',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  jsonc: 'json',
  json5: 'json',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  docker: 'dockerfile',
  patch: 'diff',
  vb: 'vbnet',
};

/** Languages tried when a code block has no tag (auto-detect stays among the usual ones). */
const AUTO = ['javascript', 'typescript', 'python', 'bash', 'powershell', 'json', 'xml', 'css', 'sql', 'yaml', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'cpp', 'c', 'diff', 'ini', 'dockerfile', 'markdown'];
const MAX = 200_000;
const MAX_AUTO = 20_000;

export function normalizeLang(lang?: string | null): string | null {
  const l = String(lang || '')
    .toLowerCase()
    .replace(/^language-/, '')
    .trim();
  if (!l) return null;
  return ALIAS[l] || l;
}

/** The language of a code file by its name; null for plain text (txt, csv, log …), which stays uncoloured. */
export function langForFile(name: string): string | null {
  const base = name.split(/[\\/]/).pop() || '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  if (/^makefile$/i.test(base)) return 'makefile';
  const e = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase();
  if (!e || ['txt', 'csv', 'tsv', 'log', 'vtt', 'srt'].includes(e)) return null;
  return ALIAS[e] || e;
}

/** Highlighted HTML (escaped by highlight.js), or null when the text should stay plain. */
export function highlightHtml(h: Hljs, code: string, lang?: string | null, o: { auto?: boolean } = {}): string | null {
  if (!code || code.length > MAX) return null;
  const l = normalizeLang(lang);
  if (l === 'text' || l === 'plaintext' || l === 'txt') return null;
  if (l && h.getLanguage(l)) return h.highlight(code, { language: l, ignoreIllegals: true }).value;
  if (!o.auto || code.length > MAX_AUTO) return null;
  if (/^\s*[[{]/.test(code)) {
    try {
      JSON.parse(code);
      return h.highlight(code, { language: 'json', ignoreIllegals: true }).value;
    } catch {
      /* not JSON */
    }
  }
  // Prose scores 1–2 in every language; real code from 3 up.
  const r = h.highlightAuto(code, AUTO);
  return r.relevance >= 3 ? r.value : null;
}

/** Highlighted HTML for a code block once the highlighter is loaded (plain text until then). */
export function useHighlight(code: string, lang?: string | null, o: { auto?: boolean; off?: boolean } = {}): string | null {
  const [h, setH] = useState<Hljs | null>(ready);
  const want = !o.off && !!code && code.length <= MAX;
  useEffect(() => {
    if (!want || h) return;
    let alive = true;
    loadHighlighter().then(
      (x) => alive && setH(() => x),
      () => {
        /* chunk failed to load (offline): stay plain text */
      },
    );
    return () => {
      alive = false;
    };
  }, [want, h]);
  return useMemo(() => {
    if (!want || !h) return null;
    try {
      return highlightHtml(h, code, lang, o);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, want, code, lang, o.auto]);
}
