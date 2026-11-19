import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A temporary folder for a test, removed when the test process ends, also after a failed or stopped test. node:test
 * runs every test file in its own process, so nothing a test makes stays behind in %TEMP%.
 */
const made: string[] = [];
process.once('exit', () => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a file still in use: the next clean-up of %TEMP% takes it */
    }
  }
});

export function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
