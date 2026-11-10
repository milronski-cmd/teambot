import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolStepStatus } from '../ui/src/shell/toolStatus.js';

// Practice test 0.4.4: after "Weigeren" the step read "Schreef een bestand · Schrijven: geheim.txt" for a file that was
// never written (the refusal also comes back as an error result for the model).
test('a refused tool step says "Niet toegestaan", also once its result is in', () => {
  assert.equal(toolStepStatus({ status: 'denied' }, { isError: true }), 'denied');
  assert.equal(toolStepStatus({ status: 'denied' }, null), 'denied');
  assert.equal(toolStepStatus({ status: 'done' }, { isError: true }), 'error');
  assert.equal(toolStepStatus({ status: 'done' }, { isError: false }), 'done');
  assert.equal(toolStepStatus({ status: 'waiting' }, null), 'waiting');
  assert.equal(toolStepStatus({}, null), undefined);
});
