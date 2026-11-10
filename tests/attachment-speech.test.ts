// Audio and video attached to a chat are written out on this computer by default (voice module, transcribeAttachment):
// an upload never goes to a paid speech service by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('attachment speech: on this computer by default, a paid service only when the owner chose it, never when off', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const owner = ctx.auth.owner()!;
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(200)]);
    const code = async () =>
      ctx.services.voice.transcribeAttachment(owner.id, wav, 'audio/wav').then(
        (r: any) => (r === null ? 'off' : 'ok'),
        (e: any) => e?.code || String(e?.message),
      );
    // Default: the local engine (here without its model: it says so), not the speech service.
    assert.equal(await code(), 'voice_local_missing');
    // The owner's own Spraak setting on a paid service changes nothing for attachments …
    ctx.store.setSetting(owner.id, 'voice', { stt: { engine: 'provider' } });
    assert.equal(await code(), 'voice_local_missing');
    // … until he chooses it for attachments (no service connected here: the provider path answers).
    ctx.store.setSetting(owner.id, 'attachmentSpeech', 'provider');
    assert.equal(await code(), 'voice_no_stt');
    ctx.store.setSetting(owner.id, 'attachmentSpeech', 'off');
    assert.equal(await code(), 'off');
  } finally {
    await t.close();
  }
});
