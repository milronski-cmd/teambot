import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, dirtySectionKeys, flushSections, listNl, prepareSections, stableJson, unsavedLabels } from '../ui/src/lib/editorSave.js';

// The bot editor has one "Opslaan" for everything (ui/src/lib/editorSave.ts). Before, the main button did not save the
// Computer section ("Mijn bureaublad", "Privé-container", "Eigen server (SSH)") and the choice was lost without a word.

test('stable JSON ignores key order and undefined values', () => {
  assert.equal(stableJson({ b: 1, a: { d: [1, 2], c: 'x' } }), stableJson({ a: { c: 'x', d: [1, 2] }, b: 1 }));
  assert.equal(stableJson({ a: 1, b: undefined }), stableJson({ a: 1 }));
  assert.notEqual(stableJson({ a: [1, 2] }), stableJson({ a: [2, 1] }));
});

test('changed fields: only what the owner edited counts, server bookkeeping does not', () => {
  const saved = { id: 'agt_1', name: 'Assistent', workspace: '', tool_groups: ['files'], settings: { voice: { autoRead: false } }, updated_at: '2026-01-01' };
  assert.deepEqual(changedFields(saved, { ...saved }), []);
  assert.deepEqual(changedFields(saved, { ...saved, updated_at: '2026-02-02', workspace: undefined }), [], 'empty workspace equals missing; updated_at is ignored');
  assert.deepEqual(changedFields(saved, { ...saved, name: 'Nieuw', settings: { voice: { autoRead: true } } }), ['name', 'settings.voice']);
  assert.deepEqual(unsavedLabels(changedFields(saved, { ...saved, settings: { ...saved.settings, folders: [{ path: 'D:/Kennis' }] } }), []), ['Mappen']);
  assert.deepEqual(changedFields(saved, { ...saved, tool_groups: ['files', 'browser'] }), ['tool_groups']);
  assert.deepEqual(changedFields(null, { name: 'x' }), []);
});

test('unsaved labels are readable and without duplicates', () => {
  assert.deepEqual(unsavedLabels(['model', 'provider_id', 'tool_policy', 'tool_groups'], ['Computer & bestanden']), ['Model', 'Tools', 'Computer & bestanden']);
  assert.deepEqual(unsavedLabels(['avatar', 'color'], []), ['Gezicht']);
  assert.equal(listNl(['Naam']), 'Naam');
  assert.equal(listNl(['Naam', 'Tools', 'Computer & bestanden']), 'Naam, Tools en Computer & bestanden');
});

test('the main save flushes every dirty section, reports failures and skips clean ones', async () => {
  const calls: string[] = [];
  const r = await flushSections([
    { label: 'Computer & bestanden', dirty: () => true, save: async () => void calls.push('computer') },
    { label: 'Schoon', dirty: () => false, save: async () => void calls.push('schoon') },
    { label: 'Kapot', dirty: () => true, save: async () => Promise.reject(new Error('Server weigert')) },
    { label: 'Na kapot', dirty: () => true, save: async () => void calls.push('na') },
  ]);
  assert.deepEqual(calls, ['computer', 'na'], 'a failing section does not stop the next one');
  assert.deepEqual(r.saved, ['Computer & bestanden', 'Na kapot']);
  assert.deepEqual(r.failed, [{ label: 'Kapot', error: 'Server weigert' }]);
});

test('prepare merges section patches into the bot (settings merged, not replaced)', async () => {
  const out = await prepareSections(
    [
      { label: 'Mappen', dirty: () => true, prepare: () => ({ settings: { folders: [{ path: 'C:\\Kennis', mode: 'ro' }] } }) },
      { label: 'Schoon', dirty: () => false, prepare: () => ({ name: 'mag niet' }) },
    ],
    { name: 'Assistent', settings: { voice: { autoRead: true } } },
  );
  assert.deepEqual(out, { name: 'Assistent', settings: { voice: { autoRead: true }, folders: [{ path: 'C:\\Kennis', mode: 'ro' }] } });
  await assert.rejects(prepareSections([{ label: 'Mappen', dirty: () => true, prepare: async () => Promise.reject(new Error('Deze map kan niet')) }], {}), /Deze map kan niet/);
});

test('a closed advanced section with unsaved fields is marked (fields map to their section)', () => {
  const saved = { name: 'A', reasoning: '', tool_groups: ['files', 'web'], tool_policy: {}, workspace: '', skills: [], settings: {} };
  assert.deepEqual(dirtySectionKeys(saved, { ...saved }), []);
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, name: 'B' }), [], 'the always-open fields have no section');
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, reasoning: 'high', settings: { fallbacks: [{ provider_id: 'p', model: '' }] } }), ['core:engine']);
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, tool_groups: ['files', 'web', 'shell'] }), ['core:tools']);
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, tool_groups: ['files', 'web', 'channels', 'routines'] }), ['channels:channels', 'routines:routines'], 'groups switched in their own section');
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, tool_policy: { browser_click: 'ask', write_file: 'deny' } }), ['browser:computer', 'core:tools']);
  assert.deepEqual(dirtySectionKeys(saved, { ...saved, workspace: 'D:/werk', skills: ['skl_1'], settings: { voice: { autoRead: true }, memory: { learn: 'off' } } }), ['core:workspace', 'memory:memory', 'skills:skills', 'voice:voice']);
});
