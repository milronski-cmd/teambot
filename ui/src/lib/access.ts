/**
 * Access levels an engine can actually enforce. Only Claude Code can be held to "Alleen chat" (no tools); Codex and
 * the ACP engines (OpenCode, Gemini CLI, …) refuse that mode at the first message (server/modules/cli-agents), so the
 * bot editor does not offer it for them. API engines (TeamBot's own tool loop) support every level.
 */
export function accessUnsupported(mode: string, engine: { type: 'api' | 'cli'; kind: string } | undefined): boolean {
  return mode === 'chat' && engine?.type === 'cli' && engine.kind !== 'claude-code';
}
