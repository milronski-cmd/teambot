import { useEffect, useState } from 'react';
import { KeyRound, Server, Terminal, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { Button, Card, EmptyState, Field, Input, Modal, Spinner, useAsync } from '../../components/ui';
import { timeShort } from './shared';
import { BotPicker, CopyField } from './forms';

/** TeamBot as an MCP server for other programs, and "teambot send" from a terminal (Apps › Meer opties). */

interface TokenView {
  id: string;
  name: string;
  agent_ids: string[];
  created_at: string;
  last_used: string | null;
}

/** `teambot send` on this installation: `node "<path>" send [--data …]`; local = the app's own sign-in works here. */
interface CliInfo {
  command: string;
  local: boolean;
}

/** Ready-to-paste `teambot send` line (double quotes work in PowerShell, cmd and bash). */
const sendLine = (cli: CliInfo, bot: string | undefined, token?: string) =>
  `${cli.command}${token ? ` --token ${token}` : ''}${bot ? ` --bot "${bot.replace(/["`$\\]/g, '')}"` : ''} "Hallo, wat kun je voor me doen?"`;

/** "From a terminal or script": the `teambot send` command, next to the tokens it can use. */
function CliCard({ cli, botName }: { cli: CliInfo; botName?: string }) {
  return (
    <Card className="space-y-3 p-4 text-sm">
      <div className="flex items-center gap-2 font-semibold">
        <Terminal className="h-4 w-4" /> Vanuit een terminal of script
      </div>
      <p className="text-muted">
        Stuur een bericht naar een bot met <span className="font-mono">teambot send</span> en krijg het antwoord terug in je terminal, of gebruik het in een script. Ook hier houdt de bot zijn eigen toegangsmodus: acties met impact keur je goed in TeamBot.
      </p>
      {cli.local ? (
        <Field label="Op deze computer (zonder token)" hint="Werkt alleen op deze computer. Voor een script dat maar bij een paar bots mag, maak je een token.">
          <CopyField value={sendLine(cli, botName)} label="Opdracht voor de terminal" />
        </Field>
      ) : (
        <p className="text-muted">Maak een token en kies de bots: je krijgt dan meteen de opdracht om te plakken.</p>
      )}
      <p className="text-xs leading-relaxed text-muted">
        Alleen naar TeamBot op deze computer, tenzij je <span className="whitespace-nowrap font-mono">--sta-extern-toe</span> toevoegt (dan alleen via https). Meer opties, zoals niet wachten op het antwoord of de uitvoer als JSON:{' '}
        <span className="whitespace-nowrap font-mono">teambot send --help</span>. Je hebt Node.js nodig.
      </p>
    </Card>
  );
}

export function ServerTab() {
  const [data, setData] = useState<{ endpoint: string; tokens: TokenView[]; cli?: CliInfo | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('Claude Desktop');
  const [bots, setBots] = useState<string[]>([]);
  const [fresh, setFresh] = useState<{ token: string; endpoint: string; bot?: string } | null>(null);
  const agents = useApp((s) => s.agents);
  const { busy, run } = useAsync();
  const load = () =>
    api
      .get<{ endpoint: string; tokens: TokenView[]; cli?: CliInfo | null }>('/mcp/server-tokens')
      .then(setData)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const create = () =>
    run(async () => {
      const r = await api.post<any>('/mcp/server-tokens', { name, agentIds: bots });
      setFresh({ token: r.token, endpoint: r.endpoint, bot: agents.find((a) => a.id === r.agent_ids?.[0])?.name });
      setCreating(false);
      setBots([]);
      load();
    });
  const revoke = (id: string) =>
    run(async () => {
      await api.del(`/mcp/server-tokens/${id}`);
      load();
    }, 'Token ingetrokken');

  if (err) return <EmptyState title="Laden mislukt">{err}</EmptyState>;
  if (!data)
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <Server className="h-4 w-4" /> TeamBot als MCP-server
        </div>
        <p className="text-muted">
          Laat een andere MCP-client (bijv. Claude Code of Claude Desktop) met je bots praten. Per token kies je welke bots bereikbaar zijn. De client krijgt alleen de tools <span className="font-mono">list_bots</span> en{' '}
          <span className="font-mono">ask_bot</span>; je bots houden hun eigen toegangsmodus en vragen in TeamBot om toestemming.
        </p>
        <Field label="Adres (Streamable HTTP)">
          <CopyField value={data.endpoint} label="Adres" />
        </Field>
        {data.endpoint.startsWith('http://127.') || data.endpoint.includes('localhost') ? <div className="text-xs text-muted">Dit adres werkt alleen op deze computer.</div> : null}
        <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} onClick={() => setCreating(true)} disabled={!agents.length}>
          Token maken
        </Button>
        {!agents.length && <div className="text-xs text-muted">Maak eerst een bot.</div>}
      </Card>
      {data.cli && agents.length > 0 && <CliCard cli={data.cli} botName={agents[0]?.name} />}
      {data.tokens.length ? (
        <div className="space-y-2">
          {data.tokens.map((t) => (
            <Card key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-muted">
                  Bots: {t.agent_ids.map((id) => agents.find((a) => a.id === id)?.name || 'verwijderd').join(', ')} · gemaakt {timeShort(t.created_at)} · laatst gebruikt {timeShort(t.last_used)}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => revoke(t.id)} disabled={busy}>
                Intrekken
              </Button>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted">Nog geen tokens.</div>
      )}
      {creating && (
        <Modal
          open
          onClose={() => setCreating(false)}
          title="Token voor een MCP-client of script"
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Annuleren
              </Button>
              <Button variant="primary" loading={busy} disabled={!bots.length} onClick={create}>
                Maken
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Naam">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Bereikbare bots">
              <BotPicker value={bots} onChange={setBots} />
            </Field>
          </div>
        </Modal>
      )}
      {fresh && (
        <Modal open onClose={() => setFresh(null)} title="Je nieuwe token" footer={<Button variant="primary" onClick={() => setFresh(null)}>Klaar</Button>}>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg bg-warn-soft p-3 text-warn">Kopieer de token nu: hij wordt maar één keer getoond.</div>
            <CopyField value={fresh.token} label="Token" />
            <Field label="Voorbeeld voor Claude Code" hint="Controleer de exacte syntaxis in de documentatie van je client.">
              <CopyField value={`claude mcp add --transport http teambot ${fresh.endpoint} --header "Authorization: Bearer ${fresh.token}"`} label="Opdracht" />
            </Field>
            {data.cli && (
              <Field
                label="Vanuit de terminal (teambot send)"
                hint={
                  <>
                    Voor een script: zet de token in de omgevingsvariabele <span className="whitespace-nowrap font-mono">TEAMBOT_TOKEN</span>, dan kan <span className="whitespace-nowrap font-mono">--token</span> weg en staat hij niet in je
                    geschiedenis.
                  </>
                }
              >
                <CopyField value={sendLine(data.cli, fresh.bot, fresh.token)} label="Opdracht voor de terminal" />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
