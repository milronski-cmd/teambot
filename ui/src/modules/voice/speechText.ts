/** Strip markdown for the browser voice (the server does the same for provider voices). No imports: also used in tests. */
export function plainForSpeech(md: string): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (codevoorbeeld overgeslagen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/[|>]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
