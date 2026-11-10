/**
 * How TeamBot opens a microphone. No imports and no DOM types: the page (audio.ts) and the tests share it.
 *
 * Every microphone TeamBot opens (dictation, memos, calls, meetings) uses the browser's echo cancellation, noise
 * suppression and automatic gain. Echo cancellation removes the bot's own voice from the speakers, so it does not hear
 * (and interrupt) itself; see also the self-voice gate in vad.ts.
 */
export const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } } as const;

/**
 * Did the browser actually switch echo cancellation on for this stream? false = it says it did not (some devices and
 * browsers cannot); null = it does not say.
 */
export function echoCancellationActive(stream: { getAudioTracks(): { getSettings?(): { echoCancellation?: unknown } }[] } | null | undefined): boolean | null {
  const track = stream?.getAudioTracks?.()[0];
  const v = track?.getSettings?.().echoCancellation;
  // Newer browsers may report the kind instead of true: "remote-only" only cancels audio of a WebRTC call, not the
  // bot's voice that this page plays itself.
  if (typeof v === 'string') return v === 'all';
  return typeof v === 'boolean' ? v : null;
}
