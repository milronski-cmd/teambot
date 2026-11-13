/**
 * What a bot does in and around its werkplek, by its access level, as the server holds it (tools/broker.ts decides per
 * level; tools/gate.ts asks for a command outside the bot's folders; tools/builtin/files.ts `wholeComputer`: on
 * "Volledige toegang" the whole computer, unless the bot keeps to its own folders). The line under "Werkplek:"
 * (Werkplek.tsx) says this, so it never contradicts the level on the bot page. No imports: unit-tested directly
 * (tests/werkplek-scope.test.ts).
 *
 *  - whole: "Volledige toegang": also outside its folders, on the whole computer, without asking.
 *  - own:   "Automatisch" (or Volledige toegang kept to its own folders): works in its folders, asks first outside them.
 *  - asks:  "Vraagt toestemming": asks before it changes anything, also inside.
 *  - read:  "Alleen lezen": reads and searches, changes nothing.
 *  - chat:  "Alleen chat": no tools, the folder is not used.
 */
export type WerkplekScope = 'whole' | 'own' | 'asks' | 'read' | 'chat';

export function werkplekScope(a: { access_mode?: string | null; settings?: Record<string, any> | null }): WerkplekScope {
  switch (a.access_mode) {
    case 'chat':
      return 'chat';
    case 'readonly':
      return 'read';
    case 'ask':
      return 'asks';
    case 'full':
      return a.settings?.ownFoldersOnly === true || a.settings?.sharedRun ? 'own' : 'whole';
    default:
      return 'own';
  }
}
