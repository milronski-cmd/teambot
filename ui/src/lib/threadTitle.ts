/** Thread titles in the chat header and lists. No imports, so it is unit-tested directly. */

/** "Routine · Weekmenu" with kind label "Routine" → "Weekmenu": the kind is already shown next to it. */
export function stripKindPrefix(title: string | null | undefined, kindLabel: string): string {
  const t = String(title || '').trim();
  if (!kindLabel) return t;
  const re = new RegExp(`^(?:${kindLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:|-]\\s*)+`, 'i');
  const rest = t.replace(re, '').trim();
  return rest || t;
}

/** Second header line for a routine, subtask or channel thread: "Routine · Weekmenu" (never "Routine · Routine · …"). */
export function threadSubtitle(kindLabel: string, title: string | null | undefined): string {
  const name = stripKindPrefix(title, kindLabel);
  return name && name.toLowerCase() !== kindLabel.toLowerCase() ? `${kindLabel} · ${name}` : kindLabel;
}
