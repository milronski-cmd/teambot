import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botInView, effectiveTeam, hiddenTaskKeys, homeMap, mainIdOf, roomInView, taskTeamOf, botIdsByName, tilesWithMain, type TeamLite } from '../ui/src/shell/teamFilter.js';
import { settingsGroupOf, settingsHostOf, staticEntries } from '../ui/src/lib/palette.js';

/** The team switcher (0.4, package A3): what a chosen team shows, and what stays visible. */
const teams: TeamLite[] = [
  { id: 'A', name: 'Bakkerij', color: '#f00', bots: [{ id: 'a1', name: 'Mila' }, { id: 'a2', name: 'Sam' }] },
  { id: 'B', name: 'Webshop', color: '#00f', bots: [{ id: 'b1', name: 'Noor' }] },
];

test('switcher: no choice with one team; a gone team falls back to Alle teams', () => {
  assert.equal(effectiveTeam('A', [teams[0]]), '', 'one team: nothing is filtered');
  assert.equal(effectiveTeam('A', teams), 'A');
  assert.equal(effectiveTeam('', teams), '');
  assert.equal(effectiveTeam(null, teams), '');
  assert.equal(effectiveTeam('weg', teams), '', 'a deleted team');
});

test('chat list: only the bots and groups of the chosen team; unknown bots stay visible', () => {
  const home = homeMap(teams);
  assert.equal(home.get('b1'), 'B');
  assert.ok(botInView('a1', 'A', home));
  assert.ok(!botInView('b1', 'A', home));
  assert.ok(botInView('nieuw', 'A', home), 'a bot just made (no team known yet) is not hidden');
  assert.ok(botInView('b1', '', home), 'Alle teams');
  assert.ok(roomInView({ bots: [{ agentId: 'a1' }, { agentId: 'b1' }] }, 'A', home), 'a group with a bot of the team');
  assert.ok(!roomInView({ bots: [{ agentId: 'b1' }] }, 'A', home));
  assert.ok(roomInView({ bots: [] }, 'B', home), 'a group without bots');
  assert.ok(!roomInView({ bots: [{ agentId: 'a1' }], teamId: 'B' }, 'A', home), "the group's own team wins when the server gives one");
});

test('main bot: marked main in GET /teams (package C2), above all teams, first among the pinned tiles (max 3)', () => {
  assert.equal(mainIdOf(teams), null, 'a server without the main-bot role: none');
  assert.equal(mainIdOf([teams[0], { ...teams[1], bots: [{ id: 'b1', name: 'Noor', main: true }] }]), 'b1');
  const p = (id: string) => ({ id });
  assert.deepEqual(tilesWithMain(p('h'), [p('a'), p('h'), p('b'), p('c')]).map((x) => x.id), ['h', 'a', 'b']);
  assert.deepEqual(tilesWithMain(undefined, [p('a'), p('b'), p('c'), p('d')]).map((x) => x.id), ['a', 'b', 'c']);
});

test('task board: a task belongs to its team, else to its bot; tasks without a team show in every team', () => {
  const home = homeMap(teams);
  const names = botIdsByName(teams);
  assert.equal(taskTeamOf({ workspace_id: 'B', owner_type: 'agent', owner_id: 'a1' }, 'board', home, names), 'B');
  assert.equal(taskTeamOf({ owner_type: 'agent', owner_id: 'a1' }, 'board', home, names), 'A');
  assert.equal(taskTeamOf({ owner_type: 'user', owner_id: 'u1' }, 'board', home, names), null);
  assert.equal(taskTeamOf({ eigenaar: ' noor ' }, 'team', home, names), 'B', 'the team database names its owner');
  assert.equal(taskTeamOf({ eigenaar: 'Iemand' }, 'team', home, names), null);
  assert.equal(taskTeamOf({ eigenaar: 'Noor', team_id: 'A' }, 'team', home, names), 'A', 'a team column wins');
  const board = [
    { id: 1, owner_type: 'agent', owner_id: 'a1' },
    { id: 2, owner_type: 'agent', owner_id: 'b1' },
    { id: 3, owner_type: 'user', owner_id: 'u1' },
  ];
  const rows = [{ id: 7, eigenaar: 'Noor' }, { id: 8, eigenaar: 'Mila' }];
  assert.deepEqual([...hiddenTaskKeys(board, rows, 'A', teams)].sort(), ['b:2', 't:7']);
  assert.deepEqual([...hiddenTaskKeys(board, rows, 'B', teams)].sort(), ['b:1', 't:8']);
  assert.equal(hiddenTaskKeys(board, rows, '', teams).size, 0, 'Alle teams hides nothing');
});

test('Instellingen: Teams under Bots en teams; module tabs have a row of their own, none is left under Algemeen by accident', () => {
  assert.equal(settingsGroupOf('teams-teams').title, 'Bots en teams');
  assert.equal(settingsGroupOf('free-models-gratis').title, 'AI-diensten');
  assert.equal(settingsGroupOf('backups-app').title, 'Privacy en back-ups');
  const elsewhere = ['teams-teams', 'free-models-gratis', 'backups-app', 'routines-routines', 'usage-limits', 'cli-agents-cli', 'mobile-telefoon', 'folders-teammap'];
  for (const id of elsewhere) assert.notEqual(settingsGroupOf(id).title, 'Algemeen', id);
  // #/m/teams/<id> (the switcher's "Teams beheren") is shown inside Instellingen with Teams marked; the palette lists
  // Teams once, as a setting in its group.
  assert.equal(settingsHostOf('teams/'), 'teams-teams');
  const mods = [{ id: 'teams', label: 'Teams', pages: [{ path: '', title: 'Teams' }], settingsTabs: [{ id: 'teams', title: 'Teams' }] }];
  const found = staticEntries(mods).filter((i) => i.title === 'Teams');
  assert.deepEqual(
    found.map((i) => [i.kind, i.subtitle]),
    [['setting', 'Instellingen · Bots en teams']],
  );
});
