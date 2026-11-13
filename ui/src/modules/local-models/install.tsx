import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { Button, Spinner } from '../../components/ui';

/** The server's install job (server/modules/local-models/install.ts). */
export interface OllamaInstallState {
  phase: 'download' | 'verify' | 'install' | 'start' | 'model' | 'done' | 'error';
  received: number;
  total: number;
  model?: string;
  error?: string;
}

const PHASE: Record<OllamaInstallState['phase'], string> = {
  download: 'Ollama downloaden',
  verify: 'Controleren of het van Ollama is',
  install: 'Ollama installeren',
  start: 'Ollama starten',
  model: 'Een model downloaden dat op deze pc goed draait',
  done: 'Klaar',
  error: '',
};

const busy = (s: OllamaInstallState | null) => !!s && s.phase !== 'done' && s.phase !== 'error';

/**
 * "Installeren" where Ollama is not on this pc yet: one click, and TeamBot installs Ollama silently (its official,
 * signed installer), connects it and fetches a model that runs well here. Progress on the spot; `onDone` when a bot
 * can use it, without another step. On a computer where TeamBot cannot install it (Linux needs a password) the
 * button says so, with the download page.
 */
export function OllamaInstallButton({ onDone, variant = 'primary' }: { onDone?(): void; variant?: 'primary' | 'secondary' }) {
  const [s, setS] = useState<OllamaInstallState | null>(null);
  const [starting, setStarting] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // An install that already runs (another page, a reload) is shown here too.
    api
      .get<OllamaInstallState | null>('/local-models/install')
      .then((x) => busy(x) && setS(x))
      .catch(() => {});
    return on('localmodels.install', (x: OllamaInstallState) => setS(x));
  }, []);
  useEffect(() => {
    if (s?.phase !== 'done') return;
    void useApp.getState().refreshProviders();
    done.current?.();
  }, [s?.phase]);
  const start = async () => {
    setStarting(true);
    try {
      setS(await api.post<OllamaInstallState>('/local-models/install', {}));
    } catch (e: any) {
      setS({ phase: 'error', received: 0, total: 0, error: e?.message || String(e) });
    } finally {
      setStarting(false);
    }
  };
  if (busy(s)) {
    const pct = (s!.phase === 'download' || s!.phase === 'model') && s!.total > 0 ? ` ${Math.min(100, Math.round((s!.received / s!.total) * 100))}%` : '';
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted" role="status" data-testid="ollama-install-progress">
        <Spinner /> {t(PHASE[s!.phase])}
        {s!.phase === 'model' && s!.model ? ` (${s!.model})` : ''}
        {pct}…
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <Button size="sm" variant={variant} icon={<Download className="h-3.5 w-3.5" />} loading={starting} onClick={start} data-testid="ollama-install" aria-label={t('{0} installeren', 'Ollama')}>
        Installeren
      </Button>
      {s?.phase === 'error' && (
        <span className="text-xs text-danger" role="alert">
          {s.error}
        </span>
      )}
    </span>
  );
}
