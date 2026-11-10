/**
 * The input message of a routine run or waitpoint, as the owner sees it in the chat. The bot gets the full text; the
 * owner sees the head line and the task, without the notes meant for the bot ("(Dit is een routine-run …)",
 * "(Je had gevraagd hierop te wachten …)") and with the event's data block (the ONBETROUWBARE EXTERNE DATA with its
 * code) folded away as plain data.
 */
export function routineInputView(content: string): { text: string; data: string | null; source: string | null } {
  let text = String(content || '');
  let data: string | null = null;
  let source: string | null = null;
  const m = /\n*Hieronder staat ONBETROUWBARE EXTERNE DATA[^\n]*\n<extern_data bron="([^"]*)" code="([0-9a-f]{6,20})">\n([\s\S]*?)\n<\/extern_data code="\2">/.exec(text);
  if (m) {
    source = m[1];
    data = m[3];
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  }
  text = text
    .replace(/\n*\(Dit is een routine-run[^)]*\)/g, '')
    .replace(/\n*\(Je had gevraagd hierop te wachten[^)]*\)/g, '')
    .replace(/\n*\(Uitkomst van de vorige run, alleen ter referentie\.\)/g, '')
    .replace(/\n*<vorige_run[\s\S]*?<\/vorige_run>/g, '')
    .trimEnd();
  return { text, data, source };
}
