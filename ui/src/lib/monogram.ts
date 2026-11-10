/** Words that say nothing about which app it is ("Azure MCP Server" → "Azure"). */
const FILLER = new Set(['mcp', 'server', 'servers', 'the', 'for', 'and', 'of', 'official', 'remote', 'model', 'context', 'protocol', 'api', 'tools']);

/** One or two letters for an app: initials of the first two words, the capitals of a CamelCase name, or its first letter. */
export function monogram(title: string, name = ''): string {
  const split = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let words = split(title).filter((w) => !FILLER.has(w.toLowerCase()));
  if (!words.length) words = split(name.split('/').pop() || name).filter((w) => !FILLER.has(w.toLowerCase()));
  if (!words.length) words = split(name.split('/')[0].split('.').filter((p) => !['io', 'com', 'github', 'co', 'app', 'dev', 'ai', 'org', 'net'].includes(p)).join(' ') || name);
  const first = (w: string) => [...w][0] || '';
  if (words.length >= 2) return (first(words[0]) + first(words[1])).toUpperCase();
  const w = words[0] || '?';
  const caps = w.match(/\p{Lu}/gu);
  if (caps && caps.length === 2 && w.length <= 12 && /^\p{Lu}/u.test(w)) return caps.join(''); // GitHub → GH
  return first(w).toUpperCase();
}
