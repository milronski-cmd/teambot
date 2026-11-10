import { useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Badge, Button, Field, Input, Spinner, askConfirm, toast, toastError } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import type { UIModule } from '../types';

interface AgentKey {
  id: string;
  name: string;
  label: string;
  via: 'agent' | 'team';
  team_name?: string;
  has_value: boolean;
  blocked?: string;
}
interface AgentKeys {
  keys: AgentKey[];
  others: { id: string; name: string; label: string }[];
  unusable: string | null;
  team: { id: string; name: string } | null;
}

/**
 * Bot editor: "Sleutels voor scripts". Give this bot (or every bot of its team) a stored secret as an environment
 * variable for its scripts; the bot only learns the name. Saved immediately. Computer-only: on a paired phone the reason.
 */
function AgentScriptKeys({ agent }: { agent: Agent; onChange(p: Partial<Agent>): void }) {
  const phone = useIsPhoneSession();
  const [data, setData] = useState<AgentKeys | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [forTeam, setForTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .get<AgentKeys>(`/script-keys/agents/${agent.id}`)
      .then((d) => (setData(d), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    if (!agent.id || phone) return;
    load();
    return on('scriptKeys.updated', () => load());
  }, [agent.id, phone]);

  if (phone) return <ComputerOnly>Sleutels voor scripts beheer je op je computer.</ComputerOnly>;
  if (!agent.id) return <p className="text-sm text-muted">Sla de bot eerst op; daarna kun je hier sleutels voor scripts geven.</p>;
  if (err)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-danger">{err}</p>
        <Button size="sm" onClick={load}>
          Opnieuw
        </Button>
      </div>
    );
  if (!data) return <Spinner />;

  const add = async () => {
    setBusy(true);
    try {
      await api.post('/script-keys', { name, value, label, ...(forTeam && data.team ? { team_id: data.team.id } : { agent_id: agent.id }) });
      setName('');
      setValue('');
      setLabel('');
      setForTeam(false);
      setAdding(false);
      toast('Sleutel opgeslagen', 'ok');
      load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const give = async (id: string) => {
    if (!id) return;
    try {
      await api.post(`/script-keys/${id}/grants`, { target: 'agent', id: agent.id });
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const takeAway = async (k: AgentKey) => {
    const team = k.via === 'team' && data.team;
    const ok = await askConfirm(team ? t('{0} weghalen bij alle bots van team “{1}”?', k.name, data.team!.name) : t('{0} weghalen bij {1}?', k.name, agent.name), { ok: 'Weghalen' });
    if (!ok) return;
    try {
      await api.del(`/script-keys/${k.id}/grants/${team ? 'team' : 'agent'}/${team ? data.team!.id : agent.id}`);
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const removeKey = async (k: AgentKey) => {
    if (!(await askConfirm(t('Sleutel {0} helemaal verwijderen, ook bij andere bots?', k.name), { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/script-keys/${k.id}`);
      load();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="space-y-3" data-testid="script-keys">
      <p className="text-sm text-muted">
        Geef de bot een sleutel of wachtwoord voor zijn scripts, onder een naam die je zelf kiest (bijvoorbeeld SHOPIFY_TOKEN). De bot ziet alleen de naam, nooit de waarde: TeamBot verbergt hem overal waar hij zou verschijnen. Wijzigingen hier worden direct opgeslagen.
      </p>
      {data.unusable && <p className="rounded-lg bg-warn-soft p-2 text-xs text-warn">{data.unusable}</p>}
      {data.keys.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {data.keys.map((k) => (
            <li key={`${k.id}:${k.via}`} className="flex flex-wrap items-center gap-2 p-2.5">
              <KeyRound className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <code className="text-sm font-medium">{k.name}</code>
                <div className="text-xs text-muted">
                  {k.label ? `${k.label} · ` : ''}
                  {k.via === 'team' ? t('voor alle bots van team “{0}”', k.team_name || '') : 'alleen voor deze bot'}
                </div>
                {k.blocked && <div className="text-xs text-warn">{k.blocked}</div>}
              </div>
              {k.blocked ? <Badge tone="warn">niet actief</Badge> : <Badge tone="ok">klaar</Badge>}
              <Button size="sm" variant="ghost" onClick={() => takeAway(k)}>
                Weghalen
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('Sleutel {0} verwijderen', k.name)} onClick={() => removeKey(k)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Deze bot heeft nog geen sleutels voor scripts.</p>
      )}
      {adding ? (
        <form
          className="space-y-3 rounded-lg border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Field label="Naam" hint="Zo heet de variabele in het script. Hoofdletters, cijfers en _.">
            <Input value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s.-]+/g, '_'))} placeholder="SHOPIFY_TOKEN" className="font-mono" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Sleutel of wachtwoord" hint="Wordt versleuteld bewaard en daarna nooit meer getoond.">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Waarvoor (optioneel)">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bijvoorbeeld: webwinkel Shopify" />
          </Field>
          {data.team && (
            <Field label="Voor wie">
              <Select value={forTeam ? 'team' : 'bot'} onChange={(e) => setForTeam(e.target.value === 'team')} aria-label="Voor wie">
                <option value="bot">Alleen voor {agent.name}</option>
                <option value="team">{t('Voor alle bots van team “{0}”', data.team.name)}</option>
              </Select>
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!name.trim() || !value.trim()}>
              Opslaan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Annuleren
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Sleutel toevoegen
          </Button>
          {data.others.length > 0 && (
            <Select className="w-auto" value="" onChange={(e) => give(e.target.value)} aria-label="Een bestaande sleutel geven">
              <option value="">Een bestaande sleutel geven…</option>
              {data.others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label ? `${o.name} (${o.label})` : o.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

const mod: UIModule = {
  id: 'script-keys',
  label: 'Sleutels voor scripts',
  agentSections: [{ id: 'keys', title: 'Sleutels voor scripts', component: AgentScriptKeys }],
};

export default mod;
