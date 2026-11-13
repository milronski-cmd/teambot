import { useEffect, useRef, useState } from 'react';
import { Download, FileText, Mic, Square } from 'lucide-react';
import { api, upload } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, EmptyState, Field, Page, PageHeader, Select, Spinner, Textarea, cx, toastError } from '../../components/ui';
import { closeMic, micProblem, openMic, Recording } from './audio';
import { PcmCapture, type PcmRecording, unlockAudio } from './capture';
import { clock, mb, money, transcribeBlob, useVoice } from './api';
import { LocalSetupModal, sttDownload } from './LocalModels';
import { t, uiLocale } from '../../lib/i18n';

const SEGMENT_MS = 45_000;

/**
 * Meeting notes (plan §21.9 P1): record a meeting with explicit consent and a visible indicator, transcribe it in
 * short segments while it runs, then let a bot write minutes from the transcript. The audio is never stored — only
 * the transcript, which you can edit before sending. Microphone only (no system/tab audio).
 */
export function MeetingPage() {
  const voice = useVoice();
  const agents = useApp((s) => s.agents).filter((a) => !a.archived && a.provider_id);
  const [consent, setConsent] = useState(false);
  const [setup, setSetup] = useState(false);
  const [title, setTitle] = useState('');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [cost, setCost] = useState(0);
  const [err, setErr] = useState('');
  const [botId, setBotId] = useState('');
  const [busy, setBusy] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<Recording | PcmRecording | null>(null);
  // Free local engine: record 16 kHz WAV (the PC cannot decode the browser's compressed formats).
  const cap = useRef<PcmCapture | null>(null);
  const timer = useRef<number | null>(null);
  const segTimer = useRef<number | null>(null);
  const startedAt = useRef(0);
  const segIndex = useRef(0);
  const parts = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const notulist = agents.find((a) => /notul/i.test(a.name + a.role));
    if (!botId && agents.length) setBotId((notulist || agents[0]).id);
  }, [agents.length]);

  // Never keep listening when the page goes away.
  useEffect(() => () => stopAll(true), []);

  const rebuild = () => setTranscript([...parts.current.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).filter(Boolean).join('\n'));

  const flushSegment = async (final = false) => {
    const r = rec.current;
    if (!r) return;
    const idx = segIndex.current++;
    rec.current = final || !stream.current ? null : cap.current ? cap.current.record() : new Recording(stream.current);
    const { blob, durationMs } = await r.stop();
    if (blob.size < 2000) return;
    setPending((n) => n + 1);
    try {
      const at = clock((Date.now() - startedAt.current - durationMs) / 1000);
      const res = await transcribeBlob(blob, { durationMs });
      parts.current.set(idx, res.text ? `[${at}] ${res.text.trim()}` : '');
      setCost((c) => c + (res.cost || 0));
      rebuild();
    } catch (e: any) {
      parts.current.set(idx, `[stuk ${idx + 1} niet getranscribeerd: ${e.message}]`);
      rebuild();
    } finally {
      setPending((n) => n - 1);
    }
  };

  const start = async () => {
    setErr('');
    unlockAudio();
    try {
      stream.current = await openMic();
      cap.current = voice.info?.settings.stt.engine === 'local' ? await PcmCapture.open(stream.current) : null;
      startedAt.current = Date.now();
      segIndex.current = 0;
      parts.current = new Map();
      setTranscript('');
      setCost(0);
      rec.current = cap.current ? cap.current.record() : new Recording(stream.current);
      setRunning(true);
      timer.current = window.setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 500);
      segTimer.current = window.setInterval(() => void flushSegment(false), SEGMENT_MS);
    } catch (e: any) {
      setErr(e.message);
      stopAll(true);
    }
  };

  function stopAll(discard = false) {
    if (timer.current) clearInterval(timer.current);
    if (segTimer.current) clearInterval(segTimer.current);
    timer.current = segTimer.current = null;
    if (discard) rec.current?.cancel();
    else void flushSegment(true);
    if (discard) rec.current = null;
    closeMic(stream.current);
    stream.current = null;
    cap.current?.close();
    cap.current = null;
    setRunning(false);
  }

  const makeMinutes = async () => {
    if (!botId || !transcript.trim()) return;
    setBusy(true);
    const from = location.hash;
    try {
      const name = `${(title || 'vergadering').replace(/[^\w\- ]+/g, '').trim() || 'vergadering'}-transcript.txt`;
      const att = await upload(new Blob([transcript], { type: 'text/plain' }), name);
      const t = await api.post<{ id: string }>('/threads', { agentId: botId, title: `Notulen: ${title || new Date().toLocaleDateString(uiLocale())}` });
      await api.post(`/threads/${t.id}/messages`, {
        content: `Maak notulen van deze vergadering${title ? ` (“${title}”)` : ''}. Het transcript staat in de bijlage (automatisch getranscribeerd; kan fouten bevatten). Geef: samenvatting, besluiten, actiepunten met eigenaar en deadline (als genoemd), en open vragen. Verzin niets dat niet in het transcript staat.`,
        attachments: [att.id],
      });
      await useApp.getState().refreshThreads();
      navigate(`/t/${t.id}`, { from });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const problem = micProblem();
  const sttReady = voice.info?.status.stt.ready;
  return (
    <Page>
      <PageHeader width="3xl" title="Vergadernotities" subtitle="Neem een vergadering op, krijg een transcript en laat een bot de notulen maken. De audio wordt niet bewaard." />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6">
        {!voice.info ? (
          <Spinner />
        ) : !sttReady ? (
          <Card>
            <EmptyState icon={<Mic className="h-6 w-6" />} title="Spraak-naar-tekst is nog niet ingesteld">
              {sttDownload(voice.info) ? (
                <div className="space-y-3">
                  <p>De gratis spraakherkenning staat nog niet op deze computer. Eén keer downloaden; daarna werkt het offline en gaat je audio niet naar internet.</p>
                  <Button variant="primary" icon={<Download className="h-4 w-4" />} onClick={() => setSetup(true)}>
                    {t('Downloaden ({0})', mb(sttDownload(voice.info)))}
                  </Button>
                </div>
              ) : (
                <>
                  {voice.info.status.stt.missing || 'Koppel een OpenAI-sleutel of een eigen transcriptiedienst.'}{' '}
                  <a className="underline" href="#/settings/voice-spraak">
                    Naar Instellingen › Meer mogelijkheden › Spraak
                  </a>
                </>
              )}
            </EmptyState>
            {setup && <LocalSetupModal need={['stt']} onClose={() => setSetup(false)} />}
          </Card>
        ) : (
          <Card className="space-y-4 p-5">
            <Field label="Naam van de vergadering (optioneel)">
              <input className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm" value={title} onChange={(e) => setTitle(e.target.value)} disabled={running} />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={running} />
              <span>Iedereen die ik opneem weet dat dit gesprek wordt opgenomen en getranscribeerd, en is daarmee akkoord.</span>
            </label>
            <p className="text-xs text-muted">
              Alleen je microfoon wordt opgenomen. Elke {SEGMENT_MS / 1000} seconden gaat een stukje audio naar {voice.info.status.stt.provider || 'je transcriptiedienst'} ({voice.info.status.stt.model || 'model'}) en komt alleen de tekst terug. De audio wordt niet opgeslagen.
            </p>
            {problem && <p className="text-sm text-danger">{problem}</p>}
            {err && <p className="text-sm text-danger">{err}</p>}
            <div className="flex flex-wrap items-center gap-3">
              {!running ? (
                <Button variant="primary" icon={<Mic className="h-4 w-4" />} disabled={!consent || !!problem} onClick={start}>
                  Opname starten
                </Button>
              ) : (
                <Button variant="danger" icon={<Square className="h-4 w-4 fill-current" />} onClick={() => stopAll(false)}>
                  Stoppen
                </Button>
              )}
              {running && (
                <span className="flex items-center gap-2 text-sm font-medium text-danger" role="status">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" /> Opname loopt · {clock(elapsed)}
                </span>
              )}
              {pending > 0 && <Badge tone="accent">{t('{0, plural, one {# stuk wordt getranscribeerd…} other {# stukken worden getranscribeerd…}}', pending)}</Badge>}
              {cost > 0 && <span className="text-xs text-muted">Kosten tot nu toe: {money(cost)}</span>}
            </div>
          </Card>
        )}

        {(transcript || running) && (
          <Card className="space-y-3 p-5">
            <div className="flex items-center gap-2 font-semibold">
              <FileText className="h-4 w-4" /> Transcript
            </div>
            <Textarea rows={12} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={running ? 'De eerste tekst verschijnt na ongeveer een halve minuut…' : ''} aria-label="Transcript (bewerkbaar)" className="font-mono text-xs" />
            <p className="text-xs text-muted">Je kunt het transcript aanpassen voordat je het verstuurt. Namen en vaktermen worden soms verkeerd verstaan.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Wie maakt de notulen?" className="min-w-[200px] flex-1">
                <Select value={botId} onChange={(e) => setBotId(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" loading={busy} disabled={running || pending > 0 || !transcript.trim() || !botId} onClick={makeMinutes}>
                Notulen laten maken
              </Button>
            </div>
            {!agents.length && (
              <p className="text-xs text-warn">
                Maak eerst een bot (bijv. de Notulist uit de{' '}
                <a className="underline" href="#/m/skills/">
                  marktplaats
                </a>
                ).
              </p>
            )}
          </Card>
        )}
        <p className={cx('text-xs text-muted', running && 'hidden')}>Tip: de Notulist-bot uit de marktplaats is hier speciaal voor gemaakt.</p>
      </div>
    </Page>
  );
}
