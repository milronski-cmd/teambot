import { useEffect, useState } from 'react';
import { ArrowRight, Upload, X } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { navigate } from '../../lib/router';
import { type Detect, obApi } from './api';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { CutoverSteps } from './Cutover';
import { OpenClawCard } from './OpenClaw';

/**
 * First-run offer on the home screen: shown only to the owner when an OpenBot installation is found on this
 * computer and it was neither imported nor dismissed.
 */
export function OpenBotBanner() {
  const [d, setD] = useState<Detect | null>(null);
  useEffect(() => {
    obApi.detect().then(setD).catch(() => setD(null));
  }, []);
  if (!d?.available || !d.found || d.imported || d.dismissed) return null;
  const dismiss = () => {
    setD({ ...d, dismissed: true });
    obApi.dismiss().catch(() => undefined);
  };
  return (
    <Card className="relative space-y-3 p-4">
      <button type="button" aria-label="Niet nu" onClick={dismiss} className="absolute end-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg">
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3 pe-8">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-3">
          <Upload className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="font-semibold">Je OpenBot-team overzetten</div>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">
            {/* One text per case (not pieces around a number), so every language can translate it as a whole. */}
            {d.workspaces
              ? t('OpenBot staat op deze computer met {0, plural, one {# bot} other {# bots}}. Neem alles in één keer mee; OpenBot blijft ongewijzigd.', d.workspaces)
              : 'OpenBot staat op deze computer. Neem alles in één keer mee; OpenBot blijft ongewijzigd.'}
          </p>
        </div>
      </div>
      <Button variant="primary" className="w-full" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/openbot-import')}>
        Bekijken wat er overkomt
      </Button>
    </Card>
  );
}

/** Settings → Overstappen: always reachable, also after dismissing the banner. */
export function ImportSettingsTab() {
  const [d, setD] = useState<Detect | null>(null);
  const load = () => obApi.detect().then(setD).catch(() => setD({ available: false, found: false }));
  useEffect(() => {
    load();
  }, []);
  return (
    <Card className="space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <Upload className="h-4 w-4 text-accent" aria-hidden /> Overstappen van OpenBot, stap voor stap
      </h2>
      <p className="text-sm text-muted">
        TeamBot leest je OpenBot-gegevens op deze computer (alleen lezen, zonder sleutels) en zet je team over. Kanalen en routines komen op pauze binnen; jij bepaalt per kanaal wanneer het overgaat. OpenBot zelf verandert nooit.
      </p>
      {d && !d.available && <p className="text-sm text-muted">Alleen de eigenaar van deze installatie kan overstappen.</p>}
      {d?.available && (
        <>
          <p className="break-all text-sm">{d.found ? `Gevonden: ${d.dataDir}` : `Niet gevonden${d.dataDir ? ` (gezocht in ${d.dataDir})` : ''}.`}</p>
          {d.imported && !d.imported.undone && <p className="text-sm text-muted">{t('Laatst overgenomen op {0}: {1, plural, one {# bot} other {# bots}}, {2, plural, one {# routine} other {# routines}}, {3, plural, one {# skill} other {# skills}}.', formatDateTime(d.imported.at), d.imported.counts.bots, d.imported.counts.routines, d.imported.counts.skills)}</p>}
          {!d.found && !d.imported && (
            <Button variant="primary" disabled icon={<ArrowRight className="h-4 w-4" />}>
              Importeer je OpenBot-team
            </Button>
          )}
          {(d.found || d.imported) && <CutoverSteps />}
          <div className="space-y-4 border-t border-line pt-3">
            <div className="text-sm font-medium">Uit een andere app</div>
            <div className="space-y-2">
              <p className="text-sm text-muted">Hermes Agent: profielen worden bots, met hun skills, herinneringen en geplande taken.</p>
              <Button icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/openbot-import?bron=hermes')}>
                Overstappen uit Hermes Agent
              </Button>
            </div>
            {/* Overstappen uit OpenClaw (0.4.4): its own files (OpenClaw.tsx), with its own preview and undo. */}
            <OpenClawCard embedded />
            <p className="text-sm text-muted">Grok Bot kun je niet importeren: het heeft geen export en bewaart niets op je computer.</p>
          </div>
        </>
      )}
    </Card>
  );
}
