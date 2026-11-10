/**
 * Text formatting for chat platforms. Bots answer in Markdown; every platform has
 * its own dialect and limits. All converters are total: any input gives valid output.
 */

const FENCE = /^\s*(```|~~~)/;

/**
 * Split a long message into chunks of at most `max` characters, preferring line
 * boundaries. Code fences that are cut get closed and reopened in the next chunk.
 */
export function splitMessage(text: string, max: number): string[] {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.trim()) return [];
  if (src.length <= max) return [src];
  const out: string[] = [];
  let cur = '';
  let fence: string | null = null; // opening fence line while inside a code block
  const flush = () => {
    if (cur.trim() && cur !== fence) out.push(fence ? cur + '\n```' : cur);
    cur = fence ?? '';
  };
  for (const line of src.split('\n')) {
    const isFence = FENCE.test(line);
    const budget = max - (fence || isFence ? 4 : 0);
    const room = Math.max(10, max - 8 - (fence ? fence.length + 1 : 0));
    for (const piece of line.length > room ? hardSplit(line, room) : [line]) {
      const cand = cur ? cur + '\n' + piece : piece;
      if (cand.length > budget && cur) {
        flush();
        cur = cur ? cur + '\n' + piece : piece;
      } else cur = cand;
    }
    if (isFence) fence = fence ? null : line.trim();
  }
  if (cur.trim() && cur !== fence) out.push(fence ? cur + '\n```' : cur);
  return out;
}

function hardSplit(line: string, room: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > room) {
    let cut = rest.lastIndexOf(' ', room);
    if (cut < room * 0.5) cut = room;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------------------
// Inline Markdown tokenizer shared by the converters.

type Tok =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; label: Tok[]; url: string }
  | { t: 'bold' | 'italic' | 'strike'; c: Tok[] };

const INLINE: { re: RegExp; make(m: RegExpExecArray, depth: number): Tok }[] = [
  { re: /`([^`\n]+)`/y, make: (m) => ({ t: 'code', v: m[1] }) },
  { re: /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/y, make: (m, d) => ({ t: 'link', label: inline(m[1], d + 1), url: m[2] }) },
  { re: /\*\*(?!\s)([^\n]+?)\*\*/y, make: (m, d) => ({ t: 'bold', c: inline(m[1], d + 1) }) },
  { re: /__(?!\s)([^\n]+?)__(?![A-Za-z0-9])/y, make: (m, d) => ({ t: 'bold', c: inline(m[1], d + 1) }) },
  { re: /~~(?!\s)([^\n]+?)~~/y, make: (m, d) => ({ t: 'strike', c: inline(m[1], d + 1) }) },
  { re: /\*(?![\s*])([^*\n]+?)\*(?![A-Za-z0-9*])/y, make: (m, d) => ({ t: 'italic', c: inline(m[1], d + 1) }) },
  { re: /_(?![\s_])([^_\n]+?)_(?![A-Za-z0-9_])/y, make: (m, d) => ({ t: 'italic', c: inline(m[1], d + 1) }) },
];

function inline(s: string, depth = 0): Tok[] {
  const out: Tok[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // `_` and `*` inside words (snake_case, 2*3) never start formatting.
    const prev = i > 0 ? s[i - 1] : ' ';
    const mayStart = depth < 4 && '`[*_~'.includes(ch) && !((ch === '_' || ch === '*') && /[A-Za-z0-9]/.test(prev) && s[i + 1] !== ch);
    let matched = false;
    if (mayStart) {
      for (const p of INLINE) {
        p.re.lastIndex = i;
        const m = p.re.exec(s);
        if (m) {
          if (buf) out.push({ t: 'text', v: buf }), (buf = '');
          out.push(p.make(m, depth));
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) buf += s[i++];
  }
  if (buf) out.push({ t: 'text', v: buf });
  return out;
}

type Block = { t: 'code'; lang: string; body: string } | { t: 'line'; kind: 'h' | 'li' | 'ol' | 'quote' | 'hr' | 'p'; text: string; indent: string; n?: string };

function blocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (f) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp('^\\s*' + (f[1] === '```' ? '```' : '~~~') + '\\s*$').test(lines[j])) body.push(lines[j++]);
      out.push({ t: 'code', lang: f[2] || '', body: body.join('\n') });
      i = j;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/))) out.push({ t: 'line', kind: 'h', text: m[1], indent: '' });
    else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) out.push({ t: 'line', kind: 'hr', text: '', indent: '' });
    else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) out.push({ t: 'line', kind: 'li', text: m[2], indent: m[1] });
    else if ((m = line.match(/^(\s*)(\d{1,4})[.)]\s+(.*)$/))) out.push({ t: 'line', kind: 'ol', text: m[3], indent: m[1], n: m[2] });
    else if ((m = line.match(/^\s{0,3}>\s?(.*)$/))) out.push({ t: 'line', kind: 'quote', text: m[1], indent: '' });
    else out.push({ t: 'line', kind: 'p', text: line, indent: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Telegram MarkdownV2

const TG_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
export const tgEscape = (s: string) => s.replace(TG_SPECIAL, '\\$&');
const tgEscapeCode = (s: string) => s.replace(/[`\\]/g, '\\$&');
const tgEscapeUrl = (s: string) => s.replace(/[)\\]/g, '\\$&');

function tgInline(toks: Tok[]): string {
  return toks
    .map((k) => {
      switch (k.t) {
        case 'text':
          return tgEscape(k.v);
        case 'code':
          return '`' + tgEscapeCode(k.v) + '`';
        case 'link':
          return '[' + tgInline(k.label) + '](' + tgEscapeUrl(k.url) + ')';
        case 'bold':
          return '*' + tgInline(k.c) + '*';
        case 'italic':
          return '_' + tgInline(k.c) + '_';
        case 'strike':
          return '~' + tgInline(k.c) + '~';
      }
    })
    .join('');
}

/** Convert (bot) Markdown into Telegram MarkdownV2 with every special character escaped. */
export function toTelegramMarkdownV2(md: string): string {
  return blocks(md)
    .map((b) => {
      if (b.t === 'code') return '```' + (b.lang ? tgEscapeCode(b.lang) : '') + '\n' + tgEscapeCode(b.body) + '\n```';
      const t = tgInline(inline(b.text));
      switch (b.kind) {
        case 'h':
          return '*' + t + '*';
        case 'hr':
          return '———';
        case 'li':
          return tgEscape(b.indent) + '• ' + t;
        case 'ol':
          return tgEscape(b.indent) + b.n + '\\. ' + t;
        case 'quote':
          return '>' + t;
        default:
          return t;
      }
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Slack mrkdwn

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slackInline(toks: Tok[]): string {
  return toks
    .map((k) => {
      switch (k.t) {
        case 'text':
          return slackEscape(k.v);
        case 'code':
          return '`' + slackEscape(k.v) + '`';
        case 'link':
          return '<' + k.url.replace(/[<>|]/g, encodeURIComponent) + '|' + slackInline(k.label).replace(/[|>]/g, ' ') + '>';
        case 'bold':
          return '*' + slackInline(k.c) + '*';
        case 'italic':
          return '_' + slackInline(k.c) + '_';
        case 'strike':
          return '~' + slackInline(k.c) + '~';
      }
    })
    .join('');
}

export function toSlackMrkdwn(md: string): string {
  return blocks(md)
    .map((b) => {
      if (b.t === 'code') return '```\n' + slackEscape(b.body) + '\n```';
      const t = slackInline(inline(b.text));
      switch (b.kind) {
        case 'h':
          return '*' + t + '*';
        case 'hr':
          return '———';
        case 'li':
          return b.indent + '• ' + t;
        case 'ol':
          return b.indent + b.n + '. ' + t;
        case 'quote':
          return '&gt; ' + t;
        default:
          return t;
      }
    })
    .join('\n');
}

/** Slack message text to plain text: <url|label>, <@U123>, entities. */
export function fromSlackText(s: string): string {
  return s
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// WhatsApp (*bold* _italic_ ~strike~ `code` ```block```)

function waInline(toks: Tok[]): string {
  return toks
    .map((k) => {
      switch (k.t) {
        case 'text':
          return k.v;
        case 'code':
          return '`' + k.v + '`';
        case 'link': {
          const label = waInline(k.label);
          return label === k.url ? k.url : `${label} (${k.url})`;
        }
        case 'bold':
          return '*' + waInline(k.c) + '*';
        case 'italic':
          return '_' + waInline(k.c) + '_';
        case 'strike':
          return '~' + waInline(k.c) + '~';
      }
    })
    .join('');
}

export function toWhatsApp(md: string): string {
  return blocks(md)
    .map((b) => {
      if (b.t === 'code') return '```' + b.body + '```';
      const t = waInline(inline(b.text));
      switch (b.kind) {
        case 'h':
          return '*' + t + '*';
        case 'hr':
          return '———';
        case 'li':
          return b.indent + '• ' + t;
        case 'ol':
          return b.indent + b.n + '. ' + t;
        case 'quote':
          return '> ' + t;
        default:
          return t;
      }
    })
    .join('\n');
}

/** Markdown to readable plain text (fallback when a platform rejects formatting, and for e-mail). */
export function toPlain(md: string): string {
  const plain = (toks: Tok[]): string =>
    toks.map((k) => (k.t === 'text' || k.t === 'code' ? k.v : k.t === 'link' ? `${plain(k.label)} (${k.url})` : plain(k.c))).join('');
  return blocks(md)
    .map((b) => {
      if (b.t === 'code') return b.body;
      const t = plain(inline(b.text));
      return b.kind === 'li' ? b.indent + '• ' + t : b.kind === 'ol' ? `${b.indent}${b.n}. ${t}` : b.kind === 'quote' ? '> ' + t : b.kind === 'hr' ? '———' : t;
    })
    .join('\n');
}

export function preview(s: string, n = 100): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
