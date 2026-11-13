import { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Field, Input, Spinner, Textarea, cx, useAsync, CardHead } from '../../components/ui';
import { api } from '../../lib/api';
import type { PublishersView } from './api';
import type { PublisherPolicy } from '../../../../shared/skills.js';
import { fmtDate } from './api';
import { Confirm } from './common';

const POLICY_HELP: Record<PublisherPolicy, string> = {
  open: 'Alles mag worden geïnstalleerd; onbekende pakketten krijgen een waarschuwing.',
  'signed-only': 'Alleen pakketten met een geldige handtekening.',
  allowlist: 'Alleen pakketten van uitgevers in de lijst hieronder.',
};

/** Settings › Vertrouwde makers: publisher policy and trusted publisher keys (members: read-only). */
export function PublishersSettings() {
  const [data, setData] = useState<PublishersView | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [pubId, setPubId] = useState('');
  const [remove, setRemove] = useState<PublishersView['trusted'][number] | null>(null);
  const { busy, run } = useAsync();
  const load = useCallback(() => {
    api
      .get<PublishersView>('/skills/publishers')
      .then((d) => (setData(d), setError('')))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (error)
    return (
      <Card className="p-4">
        <p className="text-sm text-danger">Laden mislukt: {error}</p>
        <Button className="mt-2" size="sm" onClick={load}>
          Opnieuw proberen
        </Button>
      </Card>
    );
  if (!data)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  const manage = data.canManage;
  const setPolicy = (policy: PublisherPolicy) => run(async () => setData(await api.put<PublishersView>('/skills/publishers/policy', { policy })), 'Beleid opgeslagen');
  const add = () =>
    run(async () => {
      setData(await api.post<PublishersView>('/skills/publishers/trusted', { publicKey: key.trim(), name: name.trim(), publisherId: pubId.trim() }));
      setName('');
      setKey('');
      setPubId('');
    }, 'Uitgever toegevoegd');

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <CardHead icon={ShieldCheck} tone="rose" title="Vertrouwde makers" />
        <p className="text-sm text-muted">
          Skills, bot-sjablonen en connectors kunnen door hun uitgever digitaal ondertekend zijn (Ed25519). TeamBot controleert de handtekening en elk bestand bij installeren en bijwerken. Een ongeldige handtekening of een pakket dat niet past bij deze TeamBot-versie wordt altijd geweigerd. Een update van een andere uitgever dan de geïnstalleerde vraagt altijd om bevestiging.
        </p>
        {!manage && <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">De beheerder bepaalt dit beleid. Het geldt ook voor jou{data.restricted ? '; je kunt er bij installeren niet van afwijken' : ''}.</p>}
        <fieldset className="space-y-2" disabled={!manage || busy}>
          <legend className="mb-1 text-sm font-medium">Wat mag er geïnstalleerd worden?</legend>
          {data.policies.map((p) => (
            <label key={p.id} className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', data.policy === p.id ? 'border-accent bg-accent-soft' : 'border-line', !manage && 'cursor-default')}>
              <input type="radio" name="publisher-policy" className="mt-0.5 h-4 w-4" checked={data.policy === p.id} onChange={() => setPolicy(p.id)} />
              <span>
                <span className="font-medium" translate="no">{p.label}</span>
                <span className="block text-muted">{POLICY_HELP[p.id]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {data.mode === 'server' && manage && <p className="text-xs text-muted">Op een gedeelde server gelden de regels voor leden.</p>}
      </Card>

      <Card className="space-y-3 p-4">
        <CardHead icon={KeyRound} tone="amber" title="Vertrouwde uitgevers" />
        {!data.trusted.length ? (
          <EmptyState title="Nog geen vertrouwde uitgevers">
            {manage ? 'Voeg hieronder een publieke sleutel toe, of kies “Vertrouw deze uitgever” in de marktplaats.' : 'De beheerder heeft nog geen uitgevers toegevoegd.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {data.trusted.map((t) => (
              <li key={t.publicKey} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {t.name}
                    {t.publisherId && <span className="ms-1 text-xs font-normal text-muted">({t.publisherId})</span>}
                  </div>
                  <div className="break-all font-mono text-xs text-muted">{t.fingerprint}</div>
                  {t.addedAt && <div className="text-xs text-muted">Toegevoegd {fmtDate(t.addedAt)}</div>}
                </div>
                {manage && (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4 text-danger" />} onClick={() => setRemove(t)}>
                    Verwijderen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <div className="space-y-3 border-t border-line pt-3">
            <div className="text-sm font-medium">Uitgever toevoegen</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Naam (zoals gebruikers hem zien)">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bijvoorbeeld: IT-afdeling" />
              </Field>
              <Field label="Uitgever-id (optioneel)" hint="Ter herkenning, bijvoorbeeld nl.bedrijf. Vertrouwen hangt altijd aan de sleutel.">
                <Input value={pubId} onChange={(e) => setPubId(e.target.value)} />
              </Field>
            </div>
            <Field label="Publieke sleutel" hint="De publieke sleutel van de uitgever. Vergelijk de vingerafdruk met die van de uitgever.">
              <Textarea rows={2} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs" spellCheck={false} />
            </Field>
            <div className="flex justify-end">
              <Button variant="primary" loading={busy} disabled={!name.trim() || !key.trim()} onClick={add}>
                Toevoegen
              </Button>
            </div>
          </div>
        )}
      </Card>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title="Uitgever niet meer vertrouwen?"
        confirmLabel="Verwijderen"
        danger
        busy={busy}
        onConfirm={() => remove && run(async () => (setData(await api.del<PublishersView>(`/skills/publishers/trusted/${remove.fingerprint.replace(/ /g, '')}`)), setRemove(null)), 'Uitgever verwijderd')}
      >
        <p>
          Pakketten van <strong translate="no">{remove?.name}</strong> blijven geïnstalleerd, maar tellen voortaan als “onbekende uitgever”. Met het beleid “alleen vertrouwde uitgevers” kunnen ze niet meer worden geïnstalleerd of bijgewerkt.
        </p>
      </Confirm>
    </div>
  );
}
