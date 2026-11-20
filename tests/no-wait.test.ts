/** A bot does not hold a turn open to wait: a long sleep or a slow polling loop is refused, short waits stay. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitsInTurn } from '../server/tools/no-wait.js';

test('waiting in a turn: refused with the way that works; a short pause and a quick poll are fine', () => {
  const no = (c: string) => assert.equal(waitsInTurn(c), null, c);
  const yes = (c: string) => assert.match(waitsInTurn(c) || '', /^Niet uitgevoerd: deze opdracht wacht alleen maar/, c);
  yes('L="run.log"; until grep -q "^klaar" "$L" 2>/dev/null; do sleep 60; done; tail -5 "$L"');
  yes('while ! curl -sf https://voorbeeld.nl/klaar; do sleep 30; done');
  yes('sleep 3600; node deploy.mjs');
  yes('sleep 20m && git pull');
  yes('Start-Sleep -Seconds 900; Get-Content run.log');
  yes('while ($true) { if (Test-Path klaar.txt) { break }; Start-Sleep -Seconds 60 }');
  no('npm run build && sleep 5 && curl -s http://127.0.0.1:3000');
  no('until curl -sf http://127.0.0.1:3000/health; do sleep 2; done');
  no('for i in 1 2 3 4 5; do curl -sf https://voorbeeld.nl && break; sleep 30; done');
  no('n=0; until [ $n -ge 20 ] || grep -q klaar run.log; do n=$((n+1)); sleep 30; done');
  no('Start-Sleep -Milliseconds 500; Get-Process node');
  no('git status');
  no('echo "even slapen is gezond"');
  assert.match(waitsInTurn('sleep 3600') || '', /Plan een eenmalige vaste taak \(routine\) op het moment dat het klaar moet zijn/);
});
