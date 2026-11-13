import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAction, type StartSituation, type SubscriptionFacts } from '../ui/src/pages/welcome/mainAction.js';

/**
 * The first screen has ONE main button in every situation a real PC can be in (the owner: "per scherm één hoofdactie").
 * The screens themselves are checked in tests/e2e/newcomer.mjs (startScreens); this is the decision behind it.
 */

const claude = (loggedIn = true): SubscriptionFacts => ({ id: 'claude-code', installed: true, loggedIn, billing: loggedIn ? 'subscription' : 'unknown' });
const codexMissing: SubscriptionFacts = { id: 'codex-cli', installed: false, billing: 'unknown' };
const claudeMissing: SubscriptionFacts = { id: 'claude-code', installed: false, billing: 'unknown' };
const kinds = new Map([
  ['ollama', { type: 'api', billing: 'local', group: 'local' }],
  ['anthropic', { type: 'api', billing: 'paid' }],
]);
const ollama = { key: 'k:ollama', kind: 'ollama' };

const situation = (o: { claude?: SubscriptionFacts; ollama?: boolean; openbot?: boolean; key?: boolean; subs?: null }): StartSituation => ({
  openbot: !!o.openbot,
  subs: o.subs === null ? null : [o.claude || claudeMissing, codexMissing],
  free: o.ollama ? [ollama] : [],
  keyed: o.key ? [{ id: 'prov1', kind: 'anthropic', type: 'api' }] : [],
  kinds,
});

test('first screen: one main action for nothing found, Claude Code, Ollama, OpenBot and every mix of them', () => {
  const cases: [string, Parameters<typeof situation>[0], string | null][] = [
    ['niets gevonden', {}, 'free-start'],
    ['Claude Code, ingelogd', { claude: claude() }, 'sub:claude-code'],
    ['Claude Code, nog niet ingelogd', { claude: claude(false) }, 'sub:claude-code'],
    ['Ollama', { ollama: true }, 'k:ollama'],
    ['OpenBot', { openbot: true }, 'openbot'],
    ['Claude Code + Ollama', { claude: claude(), ollama: true }, 'sub:claude-code'],
    ['Claude Code (niet ingelogd) + Ollama', { claude: claude(false), ollama: true }, 'k:ollama'],
    ['Claude Code + OpenBot', { claude: claude(), openbot: true }, 'openbot'],
    ['Ollama + OpenBot', { ollama: true, openbot: true }, 'openbot'],
    ['Claude Code + Ollama + OpenBot', { claude: claude(), ollama: true, openbot: true }, 'openbot'],
    ['een sleutel gekoppeld', { key: true }, 'p:prov1'],
    ['een sleutel + Ollama', { key: true, ollama: true }, 'k:ollama'],
    ['nog aan het kijken, niets klaar', { subs: null }, null],
    ['nog aan het kijken, Ollama al gevonden', { subs: null, ollama: true }, 'k:ollama'],
  ];
  for (const [name, o, want] of cases) assert.equal(mainAction(situation(o)), want, name);
});

test('first screen: "Niet nu" on the OpenBot offer hands the main button to the best AI', () => {
  const all = { claude: claude(), ollama: true };
  assert.equal(mainAction(situation({ ...all, openbot: true })), 'openbot');
  assert.equal(mainAction(situation({ ...all, openbot: false })), 'sub:claude-code');
});
