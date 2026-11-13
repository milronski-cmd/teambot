import { useEffect, useState } from 'react';
import { ArrowLeftRight, ArrowRight, Upload, X } from 'lucide-react';
import { Button, Card, CardHead } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { MoreOptions } from '../../components/MoreOptions';
import { navigate } from '../../lib/router';
import { type Detect, obApi } from './api';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { CutoverSteps } from './Cutover';
import { OpenClawCard } from './OpenClaw';

/**
 * The first-run offer: an OpenBot installation on this computer that was neither imported nor put away ("Niet nu").
 * Only the owner sees it. The welcome screen reads it to choose its one main button (pages/welcome/mainAction.ts).
 */
export function useOpenBotOffer() {
  const [d, setD] = useState<Detect | null>(null);
  useEffect(() => {
    obApi.detect().then(setD).catch(() => setD(null));
  }, []);
  const shown = !!d?.available && !!d.found && !d.imported && !d.dismissed;
  const dismiss = () => {
    if (d) setD({ ...d, dismissed: true });
    obApi.dismiss().catch(() => undefined);
  };
  return { d, shown, dismiss };
}

/** The offer on the home screen; `primary` when it is the screen's main action (otherwise a quiet button). */
export function OpenBotBanner({ offer, primary }: { offer: ReturnType<typeof useOpenBotOffer>; primary: boolean }) {
  const { d, shown, dismiss } = offer;
  if (!d || !shown) return null;
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
      <Button variant={primary ? 'primary' : 'secondary'} className="w-full" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/openbot-import')}>
        Bekijken wat er overkomt
      </Button>
    </Card>
  );
}

/**
 * Settings → Overstappen: always reachable, also after dismissing the banner. One card with a short head and the steps
 * (Cutover.tsx: only the step that is due is open); the folder that was read and the long explanation are behind
 * "Meer informatie", the other apps behind a fold at the bottom (open when there is no OpenBot on this computer).
 */
export function ImportSettingsTab() {
  const [d, setD] = useState<Detect | null>(null);
  const load = () => obApi.detect().then(setD).catch(() => setD({ available: false, found: false }));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5">
        <CardHead
          icon={ArrowLeftRight}
          tone="blue"
          title="Stap voor stap"
          hint={
            <>
              Je team gaat mee naar TeamBot. OpenBot zelf verandert nooit.{' '}
              <MoreInfo>
                <span className="block">
                  TeamBot leest je OpenBot-gegevens op deze computer (alleen lezen, zonder sleutels) en zet je team over. Kanalen en routines komen op pauze binnen; jij bepaalt per kanaal wanneer het overgaat. OpenBot zelf verandert nooit.
                </span>
                {d?.available && <span className="mt-1 block break-all">{d.found ? `Gevonden: ${d.dataDir}` : `Niet gevonden${d.dataDir ? ` (gezocht in ${d.dataDir})` : ''}.`}</span>}
                {d?.available && d.imported && !d.imported.undone && (
                  <span className="mt-1 block">
                    {t('Laatst overgenomen op {0}: {1, plural, one {# bot} other {# bots}}, {2, plural, one {# routine} other {# routines}}, {3, plural, one {# skill} other {# skills}}.', formatDateTime(d.imported.at), d.imported.counts.bots, d.imported.counts.routines, d.imported.counts.skills)}
                  </span>
                )}
              </MoreInfo>
            </>
          }
        />
        {d && !d.available && <p className="text-sm text-muted">Alleen de eigenaar van deze installatie kan overstappen.</p>}
        {d?.available && !d.found && !d.imported && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled icon={<ArrowRight className="h-4 w-4" />}>
              Importeer je OpenBot-team
            </Button>
            <span className="text-sm text-muted">Geen OpenBot gevonden</span>
          </div>
        )}
        {d?.available && (d.found || d.imported) && <CutoverSteps />}
      </Card>
      {d?.available && (
        <MoreOptions label="Uit een andere app" defaultOpen={!d.found && !d.imported}>
          <div className="space-y-2">
            <p className="text-sm text-muted">Hermes Agent: profielen worden bots, met hun skills, herinneringen en geplande taken.</p>
            <Button icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate('/m/openbot-import?bron=hermes')}>
              Overstappen uit Hermes Agent
            </Button>
          </div>
          {/* Overstappen uit OpenClaw (0.4.4): its own files (OpenClaw.tsx), with its own preview and undo. */}
          <OpenClawCard embedded />
          <p className="text-sm text-muted">Grok Bot kun je niet importeren: het heeft geen export en bewaart niets op je computer.</p>
        </MoreOptions>
      )}
    </div>
  );
}
