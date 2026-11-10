import { useEffect, useState } from 'react';
import { Blocks, Plug } from 'lucide-react';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import type { Agent, Message, ToolCall } from '../../lib/types';
import { Button, Spinner, Toggle, toast, toastError } from '../../components/ui';
import type { UIModule } from '../types';
import type { Conn } from './shared';
import { RiskBadge, StatusBadge, invalidateToolIndex, useToolIndex } from './shared';
import { MainPage } from './Page';
import { DetailPage } from './Detail';

/** Bot editor section: which apps this bot may use (saved immediately). */
function AgentApps({ agent }: { agent: Agent; onChange(p: Partial<Agent>): void }) {
  const [list, setList] = useState<Conn[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .get<Conn[]>(`/mcp/agents/${agent.id}`)
      .then((l) => (setList(l), setErr(null)))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    if (!agent.id) return;
    load();
    return on('mcp.updated', () => load());
  }, [agent.id]);
  if (!agent.id) return <div className="text-sm text-muted">Sla de bot eerst op; daarna kun je hier apps koppelen.</div>;
  if (err)
    return (
      <div className="space-y-2 text-sm">
        <div className="text-danger">{err}</div>
        <Button size="sm" onClick={load}>
          Opnieuw
        </Button>
      </div>
    );
  if (!list) return <Spinner />;
  const toggle = async (c: Conn, enabled: boolean) => {
    try {
      const r = await api.put<Conn>(`/mcp/agents/${agent.id}/${c.id}`, { enabled });
      setList((l) => l?.map((x) => (x.id === c.id ? { ...x, ...r } : x)) ?? l);
      toast(enabled ? `${c.display} aan voor deze bot` : `${c.display} uit voor deze bot`, 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">Wijzigingen hier worden direct opgeslagen. Alleen leestools zijn bruikbaar tot je bij de koppeling acties toestaat.</div>
      {agent.access_mode === 'chat' && <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">Deze bot staat op “alleen chat” en gebruikt geen tools.</div>}
      {list.length ? (
        <div className="space-y-2">
          {list.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-2.5">
              <div className="min-w-0">
                <button className="truncate text-start text-sm font-medium hover:underline" onClick={() => navigate(`/m/mcp/c/${c.id}`)}>
                  {c.display}
                </button>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <StatusBadge c={c} />
                  <span>{t('{0, plural, one {# tool} other {# tools}}', c.counts.usable)}</span>
                  {c.allow_actions ? <RiskBadge risk="write" /> : <RiskBadge risk="read" />}
                </div>
              </div>
              <Toggle checked={!!c.bound} onChange={(v) => toggle(c, v)} label={<span className="sr-only">{c.display} voor deze bot</span>} />
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted">Nog geen apps gekoppeld.</div>
      )}
      <Button size="sm" variant="ghost" icon={<Plug className="h-4 w-4" />} onClick={() => navigate('/m/mcp')}>
        Apps beheren
      </Button>
    </div>
  );
}

/** Tool card extra for mcp_* calls: which app, which tool, its risk. */
function McpToolCard({ call }: { call: ToolCall; message: Message }) {
  const index = useToolIndex();
  const entry = index?.[call.name];
  const generic = ['mcp_list_resources', 'mcp_read_resource', 'mcp_list_prompts', 'mcp_get_prompt'].includes(call.name);
  if (!entry && !generic) return index ? <div className="text-xs text-muted">App-tool (koppeling niet meer gevonden)</div> : null;
  const what = generic ? { mcp_list_resources: 'resources bekijken', mcp_read_resource: 'resource lezen', mcp_list_prompts: 'promptsjablonen bekijken', mcp_get_prompt: 'promptsjabloon ophalen' }[call.name] : entry!.title || entry!.tool;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Plug className="h-3.5 w-3.5 text-muted" />
      <span className="font-medium">{entry?.app || (call.args?.app ? `app “${call.args.app}”` : 'MCP-app')}</span>
      <span className="text-muted">·</span>
      <span className="font-mono">{generic ? what : entry!.tool}</span>
      {entry && entry.title && <span className="text-muted">{entry.title}</span>}
      <RiskBadge risk={entry?.risk || 'read'} />
      {call.args?.uri && <span className="truncate font-mono text-muted">{String(call.args.uri)}</span>}
      {entry && (
        <a href={`#/m/mcp/c/${entry.connectionId}`} className="ms-auto text-accent hover:underline">
          Beheer
        </a>
      )}
    </div>
  );
}

function DetailRoute({ params }: { params: string[] }) {
  return params[0] ? <DetailPage id={params[0]} /> : <MainPage />;
}

const mod: UIModule = {
  id: 'mcp',
  label: 'Apps',
  pages: [
    { path: '', title: 'Apps', icon: Blocks, nav: true, component: MainPage },
    { path: 'c', title: 'Koppeling', component: DetailRoute },
  ],
  agentSections: [{ id: 'apps', title: 'Apps', component: AgentApps }],
  toolRenderers: { 'mcp_*': McpToolCard },
  init() {
    const offs = [
      on('mcp.updated', () => invalidateToolIndex()),
      on('mcp.oauth', (d: any) => {
        if (!d?.ok && d?.error) toast(d.error, 'danger');
      }),
    ];
    return () => offs.forEach((f) => f());
  },
};

export default mod;
