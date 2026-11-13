import { useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import { Delete, Fingerprint, Lock, LogOut } from 'lucide-react';
import { Button, Card, CardHead, Field, Input, Modal, Select, Toggle, cx, toast } from '../components/ui';
import { MoreInfo } from '../components/MoreInfo';
import { Segmented } from '../components/SettingControls';
import { t, translate } from '../lib/i18n';
import { formatList } from '../lib/format';
import {
  DELAYS, PIN_MAX, PIN_MIN, hashPin, loadFails, loadLock, registerFailure, saveFails, saveLock, shouldLockAfterHidden, triesLeft, validPin, verifyPin, waitMs,
  type LockConfig,
} from './lockCore';
import { bioError, bioSupport, registerBio, verifyBio } from './webauthnLock';
import { Mark, logout } from './Sidebar';

/**
 * App lock (per device): the full-screen lock, the "is it you?" check before changing the lock, and the settings
 * card. Logic and storage: ./lockCore.ts. Unlocking only shows the app again — it never approves or answers anything.
 */

interface LockState {
  cfg: LockConfig | null;
  /** The app is hidden behind the lock screen (on start and after the chosen time in the background). */
  locked: boolean;
  /** An "is it you?" check before changing or turning off the lock. */
  confirm: { title: string; resolve(ok: boolean): void } | null;
}

export const useLock = create<LockState>(() => {
  const cfg = loadLock();
  return { cfg, locked: !!cfg, confirm: null };
});

export function lockNow() {
  if (useLock.getState().cfg) useLock.setState({ locked: true });
}

/** Resolves true after the owner unlocked again (PIN or biometrics); true right away when there is no lock. */
export function requireUnlock(title = 'Bevestig dat jij het bent'): Promise<boolean> {
  if (!useLock.getState().cfg) return Promise.resolve(true);
  return new Promise((resolve) => {
    useLock.getState().confirm?.resolve(false);
    useLock.setState({ confirm: { title, resolve } });
  });
}

function setConfig(c: LockConfig | null) {
  saveLock(c);
  useLock.setState({ cfg: loadLock(), locked: false });
}

/** Locks again after the chosen time in the background (visibility), for the whole app. */
export function useLockWatcher() {
  useEffect(() => {
    let hiddenAt: number | null = null;
    const f = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else {
        const cfg = useLock.getState().cfg;
        if (cfg && shouldLockAfterHidden(cfg.after, hiddenAt, Date.now())) useLock.setState({ locked: true });
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
}

const coarse = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

/** The lock screen. `confirm` mode (changing the lock) has a cancel button and closes over the app. */
export function LockScreen({ mode = 'unlock', title, onDone }: { mode?: 'unlock' | 'confirm'; title?: string; onDone?(ok: boolean): void }) {
  const cfg = useLock((s) => s.cfg);
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const [fails, setFails] = useState(loadFails);
  const [now, setNow] = useState(Date.now());
  const [forgot, setForgot] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const wait = waitMs(fails, now);

  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [wait > 0]);

  const done = (ok: boolean) => {
    if (ok) {
      saveFails({ fails: 0, until: 0 });
      setFails({ fails: 0, until: 0 });
    }
    if (onDone) onDone(ok);
    else if (ok) useLock.setState({ locked: false });
  };

  const check = async (value: string) => {
    if (!cfg?.pin || checking || waitMs(fails, Date.now()) > 0) return;
    setChecking(true);
    try {
      if (await verifyPin(value, cfg.pin)) return done(true);
      const f = registerFailure(fails, Date.now());
      saveFails(f);
      setFails(f);
      setNow(Date.now());
      setPin('');
      const left = triesLeft(f);
      setMsg(f.until ? 'Te vaak een onjuiste pincode.' : left === 1 ? 'Onjuiste pincode. Nog 1 poging voordat je even moet wachten.' : `Onjuiste pincode. Nog ${left} pogingen voordat je even moet wachten.`);
    } finally {
      setChecking(false);
    }
  };

  const type = (d: string) => {
    if (wait || checking || !cfg?.pin) return;
    const next = (pin + d).slice(0, PIN_MAX);
    setPin(next);
    setMsg('');
    if (next.length === cfg.pin.length) void check(next);
  };

  const bio = async () => {
    if (!cfg?.bio) return;
    setMsg('');
    try {
      if (await verifyBio(cfg.bio.credId)) return done(true);
      setMsg('Dat lukte niet. Probeer het opnieuw of gebruik je pincode.');
    } catch (e: any) {
      setMsg(`${bioError(e)}${cfg.pin ? ' Gebruik eventueel je pincode.' : ''}`);
    }
  };

  useEffect(() => {
    if (!coarse()) input.current?.focus();
  }, []);
  useEffect(() => {
    if (mode !== 'confirm') return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && done(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode]);

  if (!cfg) return null;
  const secs = Math.ceil(wait / 1000);
  const status = wait ? secs === 1 ? 'Te vaak een onjuiste pincode. Probeer het over 1 seconde opnieuw.' : `Te vaak een onjuiste pincode. Probeer het over ${secs} seconden opnieuw.` : msg;
  const key = 'flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-2xl font-semibold tabular-nums transition-colors hover:bg-surface-3 active:bg-line disabled:opacity-40';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="safe-top safe-bottom fixed inset-0 z-[100] overflow-y-auto bg-canvas" data-testid="app-lock">
      <div className="mx-auto flex min-h-full w-full max-w-xs flex-col items-center justify-center gap-5 px-6 py-8">
        <Mark size={56} />
        <div className="text-center">
          <h1 id={titleId} className="text-xl font-extrabold tracking-tight">
            {mode === 'confirm' ? title || 'Bevestig dat jij het bent' : 'TeamBot is vergrendeld'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {cfg.pin ? (cfg.bio ? 'Voer je pincode in of gebruik je vingerafdruk of gezicht.' : 'Voer je pincode in.') : 'Gebruik je vingerafdruk of gezicht.'}
          </p>
        </div>
        {cfg.pin && (
          <form
            className="w-full"
            onSubmit={(e) => {
              e.preventDefault();
              if (pin) void check(pin);
            }}
          >
            <input
              ref={input}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Pincode"
              maxLength={PIN_MAX}
              value={pin}
              disabled={!!wait}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, PIN_MAX);
                setPin(v);
                setMsg('');
                if (v.length === cfg.pin!.length) void check(v);
              }}
              className={cx('h-14 w-full rounded-2xl border bg-surface-2 text-center text-3xl tracking-[0.5em] outline-none focus:border-muted', msg ? 'border-danger' : 'border-line')}
            />
          </form>
        )}
        <p role="status" aria-live="polite" className={cx('min-h-[2.5rem] text-center text-sm', status ? 'text-danger' : 'text-muted')}>
          {status}
        </p>
        {cfg.pin && (
          <div className="grid grid-cols-3 gap-4" aria-label="Cijfers">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" className={key} disabled={!!wait || checking} onClick={() => type(d)}>
                {d}
              </button>
            ))}
            <span />
            <button type="button" className={key} disabled={!!wait || checking} onClick={() => type('0')}>
              0
            </button>
            <button type="button" className={cx(key, 'text-muted')} aria-label="Laatste cijfer wissen" disabled={!pin} onClick={() => setPin(pin.slice(0, -1))}>
              <Delete className="h-6 w-6" />
            </button>
          </div>
        )}
        {cfg.bio && (
          <Button variant={cfg.pin ? 'secondary' : 'primary'} size="lg" className="w-full justify-center" aria-label="Ontgrendelen met vingerafdruk of gezicht" icon={<Fingerprint className="h-5 w-5" />} onClick={() => void bio()}>
            Met vingerafdruk of gezicht
          </Button>
        )}
        {mode === 'confirm' ? (
          <Button variant="ghost" className="w-full justify-center" onClick={() => done(false)}>
            Annuleren
          </Button>
        ) : forgot ? (
          <div className="w-full space-y-3 rounded-2xl border border-line bg-surface p-4 text-sm">
            <p>
              Je logt uit op dit apparaat en de vergrendeling verdwijnt. Je gesprekken en bots blijven gewoon op je computer staan. Op een telefoon koppel je daarna opnieuw met de QR-code op je computer (Instellingen › Telefoon).
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setForgot(false)}>
                Terug
              </Button>
              <Button
                variant="danger"
                icon={<LogOut className="h-4 w-4" />}
                onClick={() => {
                  saveLock(null);
                  void logout();
                }}
              >
                Uitloggen op dit apparaat
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="text-sm font-semibold text-muted underline-offset-2 hover:text-fg hover:underline coarse:py-2" onClick={() => setForgot(true)}>
            {cfg.pin ? 'Pincode vergeten?' : 'Lukt het niet?'} Log uit op dit apparaat
          </button>
        )}
        <p className="text-center text-xs text-muted">Ontgrendelen keurt niets goed: vragen en goedkeuringen van je bots wachten gewoon op jou.</p>
      </div>
    </div>
  );
}

/** The "is it you?" check over the app (from requireUnlock). */
export function LockConfirmHost() {
  const c = useLock((s) => s.confirm);
  if (!c) return null;
  return (
    <LockScreen
      mode="confirm"
      title={c.title}
      onDone={(ok) => {
        useLock.setState({ confirm: null });
        c.resolve(ok);
      }}
    />
  );
}

// ------------------------------------------------------------------ settings

function PinFields({ pin, setPin, again, setAgain, label = 'Pincode' }: { pin: string; setPin(v: string): void; again: string; setAgain(v: string): void; label?: string }) {
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={label} hint={`${PIN_MIN} tot ${PIN_MAX} cijfers.`}>
        <Input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} />
      </Field>
      <Field label="Nog een keer">
        <Input type="password" inputMode="numeric" autoComplete="new-password" value={again} onChange={(e) => setAgain(digits(e.target.value))} />
      </Field>
    </div>
  );
}

function pinError(pin: string, again: string): string {
  if (!validPin(pin)) return `Kies een pincode van ${PIN_MIN} tot ${PIN_MAX} cijfers.`;
  if (pin !== again) return 'De twee pincodes zijn niet gelijk.';
  return '';
}

/** When to lock, as a segmented control: short labels (the long one is in the line above it). */
const SHORT_DELAY: Record<number, string> = { 0: 'Meteen', 1: '1 minuut', 5: '5 minuten', 15: '15 minuten' };
const DELAY_OPTIONS = DELAYS.map((d) => ({ value: String(d.value), label: SHORT_DELAY[d.value] || d.label, text: d.label }));

const delayText = (m: number) => (m === 0 ? 'meteen als je de app verlaat' : m === 1 ? 'na 1 minuut in de achtergrond' : `na ${m} minuten in de achtergrond`);

/** How this device locks, in one line: "pincode (6 cijfers) en vingerafdruk of gezicht · vergrendelt meteen …". */
const lockedHow = (cfg: LockConfig) =>
  t('{0} · vergrendelt {1}', formatList([cfg.pin ? t('pincode ({0} cijfers)', cfg.pin.length) : '', cfg.bio ? translate('vingerafdruk of gezicht') : ''].filter(Boolean)), translate(delayText(cfg.after)));

/** Instellingen › Beveiliging: "App-vergrendeling op dit apparaat". */
export function AppLockCard() {
  const cfg = useLock((s) => s.cfg);
  const [support, setSupport] = useState<{ ok: boolean; reason: string } | null>(null);
  const [setup, setSetup] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [useBio, setUseBio] = useState(false);
  const [after, setAfter] = useState(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bioSupport().then(setSupport);
  }, []);

  const reset = () => {
    setPin('');
    setAgain('');
    setErr('');
  };

  const enable = async () => {
    setErr('');
    if (!useBio || pin || again) {
      const e = pinError(pin, again);
      if (e) return setErr(useBio ? `${e} Of laat beide velden leeg om alleen je vingerafdruk of gezicht te gebruiken.` : e);
    }
    setBusy(true);
    try {
      const next: LockConfig = { v: 1, after };
      if (pin) next.pin = await hashPin(pin);
      if (useBio) next.bio = { credId: await registerBio(), created: new Date().toISOString() };
      setConfig(next);
      setSetup(false);
      reset();
      toast('App-vergrendeling staat aan op dit apparaat', 'ok');
    } catch (e: any) {
      setErr(e?.name && e.name !== 'Error' ? `Vingerafdruk of gezicht is niet ingesteld: ${bioError(e)} Probeer het opnieuw of zet die optie uit.` : e?.message || 'Instellen mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const change = async (fn: (c: LockConfig) => Promise<LockConfig | null> | LockConfig | null, title?: string) => {
    if (!cfg || !(await requireUnlock(title))) return;
    try {
      setConfig(await fn(cfg));
      return true;
    } catch (e: any) {
      toast(e?.name && e.name !== 'Error' ? `Niets gewijzigd: ${bioError(e)}` : e?.message || 'Wijzigen mislukt', 'danger');
      return false;
    }
  };

  const savePin = async () => {
    const e = pinError(pin, again);
    if (e) return setErr(e);
    const p = await hashPin(pin);
    setConfig({ ...cfg!, pin: p });
    setPinModal(false);
    reset();
    toast('Nieuwe pincode ingesteld', 'ok');
  };

  return (
    <Card className="space-y-3 p-5">
      <CardHead
        icon={Lock}
        tone="rose"
        title="App-vergrendeling op dit apparaat"
        hint={
          <>
            Pincode, vingerafdruk of gezicht als je TeamBot opent.{' '}
            <MoreInfo>Geldt alleen voor deze browser of telefoon. Je pincode verlaat dit apparaat nooit.</MoreInfo>
          </>
        }
      />
      {!cfg ? (
        <Button variant="primary" onClick={() => (reset(), setUseBio(false), setAfter(1), setSetup(true))}>
          Vergrendeling instellen
        </Button>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-semibold text-ok">Aan</span> · {lockedHow(cfg)}
          </p>
          <div className="space-y-1.5">
            <div className="text-[13px] font-semibold">Vergrendelen</div>
            <Segmented label="Wanneer vergrendelen" value={String(cfg.after)} onChange={(v) => void change((c) => ({ ...c, after: Number(v) }), 'Bevestig om de tijd te wijzigen')} options={DELAY_OPTIONS} />
          </div>
          <div className="space-y-1">
            <Toggle
              checked={!!cfg.bio}
              disabled={!cfg.bio && !support?.ok}
              label="Ontgrendelen met vingerafdruk of gezicht"
              onChange={(on) =>
                void change(
                  async (c) => {
                    if (on) return { ...c, bio: { credId: await registerBio(), created: new Date().toISOString() } };
                    if (!c.pin) throw new Error('Stel eerst een pincode in, of zet de vergrendeling uit.');
                    const { bio: _b, ...rest } = c;
                    return rest;
                  },
                  on ? 'Bevestig om vingerafdruk of gezicht aan te zetten' : 'Bevestig om vingerafdruk of gezicht uit te zetten',
                )
              }
            />
            {!cfg.bio && support && !support.ok && <p className="text-xs text-muted">{support.reason}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                if (await requireUnlock('Bevestig om de pincode te wijzigen')) (reset(), setPinModal(true));
              }}
            >
              {cfg.pin ? 'Pincode wijzigen' : 'Pincode instellen'}
            </Button>
            <Button icon={<Lock className="h-4 w-4" />} onClick={lockNow}>
              Nu vergrendelen
            </Button>
            <Button variant="ghost" className="text-danger hover:bg-danger-soft" onClick={async () => (await change(() => null, 'Bevestig om de vergrendeling uit te zetten')) && toast('App-vergrendeling staat uit', 'ok')}>
              Vergrendeling uitzetten
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={setup}
        onClose={() => setSetup(false)}
        title="App-vergrendeling instellen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSetup(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void enable()}>
              Aanzetten
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} />
          <div className="space-y-1">
            <Toggle checked={useBio} disabled={!support?.ok} onChange={setUseBio} label="Ook ontgrendelen met vingerafdruk of gezicht" />
            <p className="text-xs text-muted">{support === null ? 'Controleren of dit apparaat dat kan…' : support.ok ? 'Je apparaat vraagt om je vingerafdruk of gezicht. TeamBot ziet die nooit.' : support.reason}</p>
          </div>
          <div className="space-y-1.5">
            <div className="text-[13px] font-semibold">Vergrendelen</div>
            <Segmented label="Wanneer vergrendelen" value={String(after)} onChange={(v) => setAfter(Number(v))} options={DELAY_OPTIONS} />
          </div>
          {useBio && !pin && <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">Zonder pincode ontgrendel je met vingerafdruk of gezicht. Lukt dat niet, log dan uit en koppel opnieuw.</p>}
          {err && (
            <p role="alert" className="text-sm text-danger">
              {err}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={pinModal}
        onClose={() => setPinModal(false)}
        title={cfg?.pin ? 'Nieuwe pincode' : 'Pincode instellen'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPinModal(false)}>
              Annuleren
            </Button>
            <Button variant="primary" onClick={() => void savePin()}>
              Opslaan
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} label="Nieuwe pincode" />
          {err && (
            <p role="alert" className="text-sm text-danger">
              {err}
            </p>
          )}
        </div>
      </Modal>
    </Card>
  );
}
