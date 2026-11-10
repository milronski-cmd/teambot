/**
 * Device biometrics for the app lock: the browser's WebAuthn platform authenticator (fingerprint, face, Windows
 * Hello). Only the credential id is kept (in the lock config); the key never leaves the device's secure hardware and
 * TeamBot never sees a fingerprint or face. Browser-only (the pure rules are in ./lockCore.ts).
 */
import { b64, unb64, userVerified } from './lockCore';

const b64url = (b: ArrayBuffer) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

/** 127.0.0.1, 192.168.1.20, [::1] … */
export function isIpHost(h: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || /^\[.*\]$/.test(h);
}

/** Can this device unlock with a fingerprint or face here? With an honest reason when not. */
export async function bioSupport(): Promise<{ ok: boolean; reason: string }> {
  if (typeof window === 'undefined') return { ok: false, reason: 'Niet beschikbaar.' };
  if (!window.isSecureContext)
    return { ok: false, reason: 'Kan alleen via een beveiligde verbinding (https, bijvoorbeeld via Tailscale) of op deze computer zelf. Via het thuisnetwerk (http://…) staat de browser dit niet toe.' };
  // WebAuthn needs a name, not a number, in the address bar (a "relying party id" cannot be an IP address).
  if (isIpHost(location.hostname))
    return { ok: false, reason: `Werkt niet als TeamBot via een IP-adres open staat (${location.hostname}). Open TeamBot via een naam, zoals http://localhost op deze computer of je Tailscale-adres (…ts.net) op de telefoon.` };
  const PKC = (window as any).PublicKeyCredential;
  if (!PKC || !navigator.credentials) return { ok: false, reason: 'Deze browser ondersteunt geen vingerafdruk of gezichtsherkenning voor apps zoals TeamBot.' };
  try {
    if (await PKC.isUserVerifyingPlatformAuthenticatorAvailable()) return { ok: true, reason: '' };
  } catch {
    /* fall through */
  }
  return { ok: false, reason: 'Dit apparaat heeft geen vingerafdruk- of gezichtsherkenning die de browser kan gebruiken, of die staat uit.' };
}

/** Ask the device to make a credential for this lock; returns its id. */
export async function registerBio(): Promise<string> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'TeamBot' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'teambot-app-lock', displayName: 'TeamBot op dit apparaat' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Vingerafdruk of gezicht is niet ingesteld.');
  return b64url(cred.rawId);
}

/** True when the device confirmed it is you (user verification) with this lock's credential. */
export async function verifyBio(credId: string): Promise<boolean> {
  const got = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64url(credId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!got || b64url(got.rawId) !== credId) return false;
  const data = new Uint8Array((got.response as AuthenticatorAssertionResponse).authenticatorData);
  return userVerified(data);
}

/** A WebAuthn failure in plain words. */
export function bioError(e: any): string {
  if (e?.name === 'NotAllowedError') return 'Geannuleerd of niet herkend.';
  if (e?.name === 'SecurityError') return 'De browser staat vingerafdruk of gezicht op dit adres niet toe. Open TeamBot via een naam (zoals localhost of je Tailscale-adres) in plaats van een IP-adres.';
  if (e?.name === 'InvalidStateError') return 'Dit apparaat is al ingesteld; probeer het opnieuw.';
  return 'Vingerafdruk of gezicht werkt nu niet.';
}
