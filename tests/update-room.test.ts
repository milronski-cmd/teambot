/** A downloaded update and a team that never stops: TeamBot starts no new work of its own for a while, so it can install. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_AGAIN_MS, ROOM_FOR_UPDATE_MS, makingRoomForUpdate, resetRoomForUpdate } from '../server/modules/backups/app-update.js';

const ctxWith = (info: any) => ({ services: { appUpdate: info ? { info: () => info } : undefined }, log: { info() {} } }) as any;
const info = (o: { phase?: string; soon?: boolean; auto?: string; waits?: any[] }) => ({ state: { phase: o.phase ?? 'ready' }, soon: !!o.soon, config: { auto: o.auto ?? 'on' }, waitingFor: o.waits ?? [{ kind: 'runs', count: 7 }] });

test('an update that waits only for running work makes room: no new work of its own, for a bounded time', () => {
  const t0 = Date.parse('2026-11-20T03:00:00Z');
  resetRoomForUpdate();
  // Not in the app, nothing downloaded, updates off, or nothing in the way: work goes on.
  assert.equal(makingRoomForUpdate(ctxWith(null), t0), false);
  assert.equal(makingRoomForUpdate(ctxWith(info({ phase: 'idle' })), t0), false);
  assert.equal(makingRoomForUpdate(ctxWith(info({ auto: 'notify' })), t0), false);
  assert.equal(makingRoomForUpdate(ctxWith(info({ waits: [] })), t0), false);
  // The owner is at the computer or chatting: nobody is interrupted for an automatic update …
  assert.equal(makingRoomForUpdate(ctxWith(info({ waits: [{ kind: 'runs', count: 2 }, { kind: 'user' }] })), t0), false);
  assert.equal(makingRoomForUpdate(ctxWith(info({ waits: [{ kind: 'runs', count: 2 }, { kind: 'chatting', at: '' }] })), t0), false);
  // … but "Nu bijwerken" is the owner's own word: chatting does not hold it.
  assert.equal(makingRoomForUpdate(ctxWith(info({ soon: true, auto: 'notify', waits: [{ kind: 'runs', count: 2 }, { kind: 'chatting', at: '' }] })), t0), true);
  resetRoomForUpdate();
  // Only work in the way: room is made, for at most ROOM_FOR_UPDATE_MS; then the work goes on and it tries again later.
  const busy = ctxWith(info({ waits: [{ kind: 'runs', count: 7 }, { kind: 'routine-soon', name: 'Mailronde', at: '' }] }));
  assert.equal(makingRoomForUpdate(busy, t0), true);
  assert.equal(makingRoomForUpdate(busy, t0 + ROOM_FOR_UPDATE_MS - 1000), true);
  assert.equal(makingRoomForUpdate(busy, t0 + ROOM_FOR_UPDATE_MS + 1000), false, 'the team is not held for ever');
  assert.equal(makingRoomForUpdate(busy, t0 + ROOM_FOR_UPDATE_MS + ROOM_AGAIN_MS - 1000), false);
  assert.equal(makingRoomForUpdate(busy, t0 + ROOM_FOR_UPDATE_MS + ROOM_AGAIN_MS + 1000), true, 'a new try later');
  resetRoomForUpdate();
});
