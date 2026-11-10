import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { formatTime } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Spinner, Toggle, toast, toastError } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { MoreInfo } from '../../components/MoreInfo';
import { MoreOptions } from '../../components/MoreOptions';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';

/**
 * Instellingen › Geavanceerd › Zoeken (0.4.5): which source web_search tries first (Automatisch = the free chain in
 * server/tools/builtin/web.ts), the optional own free keys (encrypted in Secrets, set on the computer) and the Jina
 * Reader switch for pages TeamBot cannot read itself. Data: GET /api/web-search/status, saved through PUT /api/settings.
 */

type Choice = 'auto' | 'keenable' | 'parallel' | 'tavily' | 'exa' | 'brave' | 'searxng' | 'duckduckgo';
type Keyed = 'tavily' | 'exa' | 'brave';

interface Status {
  choice: Choice;
  url: string | null;
  jinaReader: boolean;
  keys: Record<Keyed, boolean>;
  last: { source: string; at: string; tried: { source: string; reason: string }[] } | null;
}

const CHOICES: { id: Choice; label: string }[] = [
  { id: 'auto', label: 'Automatisch (aanbevolen)' },
  { id: 'keenable', label: 'Keenable eerst' },
  { id: 'parallel', label: 'Parallel eerst' },
  { id: 'tavily', label: 'Tavily eerst (eigen sleutel)' },
  { id: 'exa', label: 'Exa eerst (eigen sleutel)' },
  { id: 'brave', label: 'Brave Search eerst (eigen sleutel)' },
  { id: 'duckduckgo', label: 'DuckDuckGo eerst' },
  { id: 'searxng', label: 'Alleen mijn eigen SearXNG' },
];

/** Names of services: never translated. */
const NAME: Record<string, string> = { keenable: 'Keenable', parallel: 'Parallel', tavily: 'Tavily', exa: 'Exa', brave: 'Brave Search', searxng: 'SearXNG', duckduckgo: 'DuckDuckGo', wikipedia: 'Wikipedia' };

/** The same secret names as SEARCH_KEY_SECRET on the server. */
const SECRET: Record<Keyed, string> = { tavily: 'search_tavily', exa: 'search_exa', brave: 'search_brave' };

interface KeyInfo {
  id: Keyed;
  hint: string;
  signup: string;
  link: string;
  placeholder: string;
}
const FREE_KEYS: KeyInfo[] = [
  { id: 'tavily', hint: 'Gratis: 1.000 zoekopdrachten per maand, zonder creditcard.', signup: 'https://app.tavily.com', link: 'Gratis sleutel maken', placeholder: 'tvly-…' },
  { id: 'exa', hint: 'Gratis: elke maand $10 tegoed (ongeveer 1.400 zoekopdrachten), zonder creditcard.', signup: 'https://dashboard.exa.ai', link: 'Gratis sleutel maken', placeholder: 'Plak hier je sleutel' },
];
const BRAVE_KEY: KeyInfo = { id: 'brave', hint: 'Voor wie al een sleutel van de Brave Search API heeft.', signup: 'https://api-dashboard.search.brave.com', link: 'Brave Search API', placeholder: 'Plak hier je sleutel' };

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="inline-flex items-center gap-0.5 underline" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink className="h-3 w-3 rtl-keep" aria-hidden />
    </a>
  );
}

export function WebSearchSettings() {
  const phone = useIsPhoneSession();
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  const load = () =>
    api.get<Status>('/web-search/status').then(
      (x) => {
        setS(x);
        setUrl(x.url || '');
        setErr(null);
      },
      (e) => setErr(e?.message || String(e)),
    );
  useEffect(() => {
    load();
    return on('settings.updated', load);
  }, []);

  if (err && !s)
    return (
      <Card className="space-y-3 p-5">
        <p className="text-sm text-danger">{t('De zoekinstellingen konden niet worden geladen: {0}', err)}</p>
        <Button onClick={load}>Opnieuw proberen</Button>
      </Card>
    );
  if (!s) return <Spinner />;

  const save = async (patch: { provider?: Choice; url?: string; jinaReader?: boolean }, done?: string) => {
    try {
      const settings = await api.put('/settings', { search: { provider: s.choice, url: s.url || '', jinaReader: s.jinaReader, ...patch } });
      useApp.setState({ settings });
      await load();
      if (done) toast(done, 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const needsKey = (s.choice === 'tavily' || s.choice === 'exa' || s.choice === 'brave') && !s.keys[s.choice];

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <h2 className="text-[15px] font-bold tracking-tight">Zoeken op internet</h2>
        <div className="space-y-1">
          <p className="text-sm text-muted">Bots zoeken meteen, zonder sleutel of account.</p>
          <MoreInfo block>
            <p>Automatisch zoekt TeamBot eerst bij Keenable en Parallel: gratis zoekdiensten voor AI-assistenten, zonder sleutel. Daarna volgen je eigen sleutels (Tavily, Exa, Brave Search), dan DuckDuckGo, en als laatste Wikipedia.</p>
            <p>Bij elke zoekopdracht gaat alleen de zoekterm naar die dienst (Keenable, Parallel, Tavily en Exa zitten in de VS). Webpagina’s die een bot daarna leest, haalt TeamBot zelf op.</p>
            <p>Zonder sleutel geldt een limiet per internetadres, bij Keenable 1.000 zoekopdrachten per uur. Is een dienst op zijn limiet, dan slaat TeamBot hem even over.</p>
            <p>Kies je je eigen SearXNG, dan zoekt TeamBot alleen daar, ook als die server even niet antwoordt.</p>
          </MoreInfo>
        </div>
        <Field label="Zoekdienst" hint={needsKey ? 'Vul hieronder eerst een sleutel in; tot dan zoekt TeamBot automatisch.' : undefined}>
          <Select value={s.choice} onChange={(e) => save({ provider: e.target.value as Choice }, 'Opgeslagen')}>
            {CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        {s.choice === 'searxng' && (
          <Field label="Adres van je SearXNG" hint={!s.url ? 'Zonder adres zoekt TeamBot automatisch.' : undefined}>
            <div className="flex gap-2">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://zoek.voorbeeld.nl" aria-label="Adres van je SearXNG" spellCheck={false} translate="no" />
              <Button onClick={() => save({ url: url.trim() }, 'Opgeslagen')}>Opslaan</Button>
            </div>
          </Field>
        )}
        {s.last && (
          <p className="text-xs text-muted" data-testid="search-last">
            {t('Laatste zoekopdracht ({0}): beantwoord door {1}.', formatTime(s.last.at), NAME[s.last.source] || s.last.source)}
          </p>
        )}
        <div className="space-y-1 border-t border-line pt-4">
          <Toggle checked={s.jinaReader} onChange={(v) => save({ jinaReader: v }, v ? 'Jina Reader staat aan' : 'Jina Reader staat uit')} label="Pagina’s lezen via Jina als het zelf niet lukt" />
          <p className="text-xs text-muted">
            Het adres van zo’n pagina gaat dan naar Jina AI.{' '}
            <MoreInfo>
              Sommige pagina’s bouwt JavaScript pas in de browser op, en een gescande pdf heeft geen tekst. TeamBot zelf krijgt daar bijna niets uit. Met deze schakelaar leest Jina Reader (r.jina.ai, zonder sleutel, ongeveer 20 pagina’s per minuut) zo’n pagina in een echte browser. Alleen het adres gaat naar Jina, nooit een adres in je eigen netwerk, en TeamBot vraagt Jina het verzoek niet te bewaren. Staat hij uit, dan zegt de bot eerlijk dat de pagina leeg bleef.
            </MoreInfo>
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-[15px] font-bold tracking-tight">Eigen gratis sleutels</h2>
        <p className="text-xs text-muted">Niet nodig, wel handig als reserve.</p>
        {phone ? (
          <ComputerOnly>Sleutels voor zoekdiensten vul je op je computer in.</ComputerOnly>
        ) : (
          FREE_KEYS.map((k) => <KeyRow key={k.id} k={k} has={s.keys[k.id]} reload={load} />)
        )}
      </Card>

      <MoreOptions>
        <h3 className="text-sm font-semibold">Brave Search</h3>
        {phone ? <ComputerOnly>Sleutels voor zoekdiensten vul je op je computer in.</ComputerOnly> : <KeyRow k={BRAVE_KEY} has={s.keys.brave} reload={load} />}
        {s.last && s.last.tried.length > 0 && (
          <p className="text-xs text-muted">{t('Bij de laatste zoekopdracht eerst geprobeerd: {0}.', s.last.tried.map((x) => NAME[x.source] || x.source).join(', '))}</p>
        )}
        <p className="text-xs text-muted">
          Een zoekdienst als app met al zijn eigen tools koppel je bij{' '}
          <a className="underline hover:text-fg" href="#/m/mcp">
            Apps
          </a>
          .
        </p>
      </MoreOptions>
    </div>
  );
}

/** One own key: paste and save (to Secrets, by its fixed name), or remove. The value never comes back. */
function KeyRow({ k, has, reload }: { k: KeyInfo; has: boolean; reload(): void }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const name = NAME[k.id];
  const store = async () => {
    setBusy(true);
    try {
      await api.put(`/secrets/${SECRET[k.id]}`, { value: v.trim() });
      setV('');
      toast(t('Sleutel voor {0} opgeslagen', name), 'ok');
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/secrets/${SECRET[k.id]}`);
      toast(t('Sleutel voor {0} verwijderd', name));
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <span translate="no">{name}</span>
        {has ? <Badge tone="ok">Sleutel opgeslagen</Badge> : <Badge>Geen sleutel</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Input className="min-w-[11rem] flex-1" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={has ? 'Nieuwe sleutel' : k.placeholder} aria-label={t('Sleutel voor {0}', name)} />
        <Button onClick={store} disabled={!v.trim()} loading={busy}>
          Opslaan
        </Button>
        {has && (
          <Button variant="ghost" onClick={remove} disabled={busy}>
            Verwijderen
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">
        {k.hint} <ExtLink href={k.signup}>{k.link}</ExtLink>
      </p>
    </div>
  );
}
