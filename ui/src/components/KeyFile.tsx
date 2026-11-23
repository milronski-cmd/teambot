import { useRef, useState } from 'react';
import { FileKey } from 'lucide-react';
import { cx } from './ui';
import { t } from '../lib/i18n';

/**
 * "Uit bestand" next to a field for a key, token or password (4.17.0, every such field; first only the keys for
 * scripts and the bank). A key that lies in a file — a download, a note on the desktop — is chosen, never copied and
 * pasted: this computer reads the file and fills the field (still hidden as dots), the text goes nowhere else. A
 * line NAME=value (an .env file) gives its value; a JSON file with one key field gives that field.
 */
export function keyFromText(text: string): string {
  const s = String(text || '').replace(/^﻿/, '').trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const hit = Object.entries(j).find(([k, v]) => typeof v === 'string' && /(api[_-]?key|key|token|secret|password|wachtwoord)$/i.test(k));
      if (hit) return String(hit[1]).trim();
    } catch {
      /* not JSON after all: the text itself */
    }
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 1) {
    const m = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*["']?(.+?)["']?$/.exec(lines[0]);
    return (m ? m[1] : lines[0]).trim();
  }
  // Several lines: a key file (PEM) is kept whole; an .env with one key-like line gives that value.
  if (/-----BEGIN /.test(s)) return s;
  const key = lines.map((l) => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*["']?(.+?)["']?$/.exec(l)).filter((m) => m && /(KEY|TOKEN|SECRET|PASSWORD|PASS)$/i.test(m[1]));
  return key.length === 1 ? key[0]![2].trim() : s;
}

export function KeyFromFile({ onKey, className, label }: { onKey(value: string, fileName: string): void; className?: string; label?: string }) {
  const [file, setFile] = useState('');
  const input = useRef<HTMLInputElement>(null);
  return (
    <label className={cx('inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg', className)} data-testid="key-from-file">
      <FileKey className="h-3.5 w-3.5" aria-hidden />
      {file ? t('Gelezen uit {0}', file) : label || t('Uit bestand')}
      <input
        ref={input}
        type="file"
        accept=".txt,.key,.pem,.env,.json,text/plain"
        className="sr-only"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const value = keyFromText(await f.text());
          if (input.current) input.current.value = '';
          if (!value) return;
          setFile(f.name);
          onKey(value, f.name);
        }}
      />
    </label>
  );
}
