import { useEffect, useRef } from 'react';
import { CheckCircle2, Download, Loader2, Trash2, X } from 'lucide-react';
import { askConfirm, Badge, Button, Modal, Spinner, cx, toastError } from '../../components/ui';
import { type LocalModelView, type VoiceInfo, mb, useLocalModels, useVoice } from './api';
import { getLang, t, translate } from '../../lib/i18n';
import { formatPercent } from '../../lib/format';
import { langName } from './VoiceFields';

/** A "the local model is not downloaded yet" error from the server (HTTP 409). */
export function isLocalMissing(e: any): boolean {
  return e?.status === 409;
}

/** The progress bar of one download (also in the first view of Instellingen › Meer mogelijkheden › Spraak). */
export function Progress({ m }: { m: LocalModelView }) {
  const pct = m.total ? Math.min(100, Math.round((100 * m.received) / m.total)) : 0;
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t('Download {0}', translate(m.label))}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-muted">
        {m.status === 'verifying' ? 'Controleren…' : `${mb(m.received)} van ${mb(m.total)} (${formatPercent(pct)})`}
      </div>
    </div>
  );
}

/**
 * One downloadable model/voice: size, licence, status, download/cancel/remove. `badge`: why it fits (e.g. recommended
 * for the interface language); `note`: a limitation (e.g. does not know the language).
 */
export function LocalModelRow({
  m,
  canManage,
  act,
  selected,
  onSelect,
  badge,
  note,
}: {
  m: LocalModelView;
  canManage: boolean;
  act(id: string, what: 'install' | 'cancel' | 'remove'): Promise<void>;
  selected?: boolean;
  onSelect?(): void;
  badge?: string;
  note?: string;
}) {
  const busy = m.status === 'downloading' || m.status === 'verifying';
  const run = (what: 'install' | 'cancel' | 'remove') => act(m.id, what).catch(toastError);
  return (
    <div className={cx('space-y-1.5 rounded-xl border p-3', selected ? 'border-accent bg-accent-soft' : 'border-line', note && 'opacity-80')}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {onSelect ? (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={!!selected} onChange={onSelect} className="accent-accent" />
                {m.label}
              </label>
            ) : (
              m.label
            )}
            {m.status === 'installed' && (
              <Badge tone="ok">
                <CheckCircle2 className="me-0.5 inline h-3 w-3" />
                op deze computer
              </Badge>
            )}
            {m.status === 'unsupported' && <Badge tone="warn">niet voor dit systeem</Badge>}
            {badge && <Badge tone="accent">{badge}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted">{m.description}</div>
          {note && <div className="mt-0.5 text-xs text-warn">{note}</div>}
          <div className="mt-0.5 text-[11px] text-muted">
            {mb(m.size)} · licentie {m.licence}
            {m.speedHint ? ` · ${m.speedHint}` : ''}
            {m.licenceNote ? ` · ${m.licenceNote}` : ''}{' '}
            <a className="underline" href={m.source} target="_blank" rel="noreferrer">
              bron
            </a>
          </div>
        </div>
        {canManage && m.status !== 'unsupported' && (
          <div className="flex shrink-0 gap-1.5">
            {busy ? (
              <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} aria-label={t('Downloaden van {0} stoppen', translate(m.label))} onClick={() => run('cancel')}>
                Stoppen
              </Button>
            ) : m.status === 'installed' ? (
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={t('{0} verwijderen', translate(m.label))} title="Verwijderen (vrijmaken schijfruimte)" onClick={async () => (await askConfirm(`${m.label} van deze computer verwijderen?`, { ok: 'Verwijderen', danger: true })) && run('remove')} />
            ) : (
              <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} aria-label={t('{0} downloaden', translate(m.label))} onClick={() => run('install')}>
                Downloaden
              </Button>
            )}
          </div>
        )}
      </div>
      {busy && <Progress m={m} />}
      {m.status === 'error' && m.error && <div className="text-xs text-danger">{m.error}</div>}
    </div>
  );
}

/**
 * First use: explain what will be downloaded (size, licence), download with progress and close when ready.
 * `need`: which of the user's chosen local engines must be present.
 */
/** Bytes still to download for the free call (speech recognition + the voice for the interface language). */
export function freeCallDownload(info: VoiceInfo | null): number {
  if (!info) return 0;
  const sttId = info.settings.stt.localModel || info.effective?.stt.localModel || '';
  const voiceId = info.settings.tts.localVoice || info.effective?.tts.localVoice || '';
  const piper = info.local.models.find((m) => m.id === voiceId)?.voiceEngine !== 'vits';
  const ids = [sttId, ...(voiceId ? [...(piper ? ['piper-runtime'] : []), voiceId] : [])].filter(Boolean);
  return info.local.models.filter((m) => ids.includes(m.id) && m.status !== 'installed' && m.status !== 'unsupported').reduce((n, m) => n + m.size, 0);
}

/**
 * The free speech recognition still to download on this computer (bytes), or 0: it is there, another recogniser is
 * chosen, or this user cannot download (then the page says who can).
 */
export function sttDownload(info: VoiceInfo | null): number {
  if (!info || info.settings.stt.engine !== 'local' || !info.local.canManage) return 0;
  const id = info.settings.stt.localModel || info.effective?.stt.localModel || '';
  const m = info.local.models.find((x) => x.id === id);
  return m && m.status !== 'installed' && m.status !== 'unsupported' ? m.size : 0;
}

/**
 * onReady: "Klaarmaken en bellen" — "Downloaden en bellen" goes on to the call by itself once the download is done
 * (without a second tap); when everything was already there, the footer offers to start the call.
 */
export function LocalSetupModal({ need, onClose, onReady }: { need: ('stt' | 'tts')[]; onClose(): void; onReady?(): void }) {
  const { info } = useVoice();
  const { view, error, act } = useLocalModels();
  const started = useRef(false);
  // The automatic choices (empty in the settings) are the model and voice for the interface language.
  const sttId = info ? info.settings.stt.localModel || info.effective?.stt.localModel || '' : '';
  const voiceId = info ? info.settings.tts.localVoice || info.effective?.tts.localVoice || '' : '';
  const noVoice = need.includes('tts') && !!info && !voiceId;
  // A Piper voice also needs the Piper program; a voice that runs in TeamBot itself does not.
  const piperVoice = view?.models.find((m) => m.id === voiceId)?.voiceEngine !== 'vits';
  const ids = [...(need.includes('stt') && sttId ? [sttId] : []), ...(need.includes('tts') && voiceId ? [...(piperVoice ? ['piper-runtime'] : []), voiceId] : [])];
  const models = (view?.models || []).filter((m) => ids.includes(m.id));
  const missing = models.filter((m) => m.status !== 'installed' && m.status !== 'unsupported');
  const running = models.some((m) => m.status === 'downloading' || m.status === 'verifying');
  const total = missing.reduce((n, m) => n + m.size, 0);
  const done = !!view && models.length > 0 && !missing.length;
  useEffect(() => {
    if (!done || !started.current || !onReady) return;
    started.current = false;
    onReady();
  }, [done, onReady]);
  return (
    <Modal
      open
      onClose={onClose}
      title={need.includes('stt') ? 'Gratis spraakherkenning op deze computer' : 'Gratis voorleesstem op deze computer'}
      footer={
        done ? (
          onReady ? (
            <Button variant="primary" onClick={onReady}>
              Klaar — nu bellen
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Klaar — probeer het nu
            </Button>
          )
        ) : view && !ids.length ? (
          <Button variant="primary" onClick={onClose}>
            Sluiten
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {running ? 'Op de achtergrond verder' : 'Later'}
            </Button>
            <Button
              variant="primary"
              icon={running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              disabled={running || !missing.length || !view?.canManage}
              onClick={async () => {
                started.current = true;
                for (const m of missing) await act(m.id, 'install').catch(toastError);
              }}
            >
              {running ? 'Bezig met downloaden…' : onReady ? t('Downloaden en bellen ({0})', mb(total)) : t('Downloaden ({0})', mb(total))}
            </Button>
          </>
        )
      }
    >
      {!view ? (
        error ? <div className="text-sm text-danger">{error}</div> : <Spinner />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            {need.includes('stt')
              ? 'Je spraak wordt op deze computer omgezet in tekst. Eén keer downloaden; daarna werkt het offline.'
              : 'Antwoorden worden op deze computer voorgelezen. Eén keer downloaden.'}
          </p>
          {noVoice && (
            <p className="text-warn">
              Voor het {langName(getLang())} is er nog geen gratis lokale stem met een vrije licentie. De stem van je browser of systeem leest voor; bij Instellingen › Meer mogelijkheden › Spraak kun je een stem voor een andere taal kiezen.
            </p>
          )}
          {!view.canManage && <p className="text-warn">Alleen de eigenaar van de TeamBot-computer kan dit downloaden.</p>}
          {models.map((m) => (
            <LocalModelRow key={m.id} m={m} canManage={view.canManage} act={act} />
          ))}
          <p className="text-[11px] text-muted">Controle met SHA-256 na het downloaden. Wijzigen of verwijderen kan bij Instellingen › Meer mogelijkheden › Spraak.</p>
        </div>
      )}
    </Modal>
  );
}
