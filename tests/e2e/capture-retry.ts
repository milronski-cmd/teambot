// Screenshots in the Electron checks (webContents.capturePage). Right after Electron was downloaded, the first
// capture can fail once while Chromium's GPU process is still starting: capturePage() then rejects with
// "UnknownVizError" (Electron's OnCapturePageDone, a failed frame copy). Only that error is tried again, after a
// short pause; any other error (Frame Gone, Timeout, ...) and a lasting UnknownVizError still fail the check.

export const isVizHiccup = (e: unknown) => /\bUnknownVizError\b/.test(String((e as any)?.message ?? e));

export async function captureWithRetry<T>(
  capture: () => Promise<T>,
  o: { tries?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, e: unknown) => void } = {},
): Promise<T> {
  const tries = o.tries ?? 4;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture();
    } catch (e) {
      if (attempt >= tries || !isVizHiccup(e)) throw e;
      o.onRetry?.(attempt, e);
      await sleep((o.pauseMs ?? 500) * attempt);
    }
  }
}
