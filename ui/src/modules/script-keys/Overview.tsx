import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, CardHead, EmptyState, Field, Input, Modal, Spinner, askConfirm, timeAgo, toast, toastError, useAsync } from '../../components/ui';

/** GET /api/script-keys: never a value, only whether one is stored. */
interface KeyView {
  id: string;
  name: string;
  label: string;
  has_value: boolean;
  team_id: string | null;
  grants: { target: 'agent' | 'team'; id: string; name: string; blocked?: string }[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/**
 * Kluis › "Sleutels voor scripts": every script key of the owner in one list (name, what for, which bots and teams
 * get it, last used), with a new value or delete. Adding a key or giving it to a bot happens in the bot editor.
 * Computer-only like the vault itself (the page does not render this on a paired phone).
 */
export function ScriptKeysOverview() {
  const [list, setList] = useState<KeyView[] | null>(null);
  const [err, setErr] = useState('');
  const [renew, setRenew] = useState<KeyView | null>(null);
  const load = () =>
    api
      .get<KeyView[]>('/script-keys')
      .then((d) => (setList(d), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
    return on('scriptKeys.updated', () => load());
  }, []);

  const remove = async (k: KeyView) => {
    if (!(await askConfirm(t('Sleutel {0} helemaal verwijderen, ook bij andere bots?', k.name), { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/script-keys/${k.id}`);
      toast('Sleutel verwijderd', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="script-keys-overview" data-testid="script-keys-overview">
      <CardHead id="script-keys-overview" icon={KeyRound} tone="amber" title="Sleutels voor scripts" hint="Sleutels voor de scripts van je bots. Een bot ziet alleen de naam, nooit de waarde." />
      {err ? (
        <div className="space-y-2 text-sm">
          <p className="text-danger">{err}</p>
          <Button size="sm" onClick={load}>
            Opnieuw
          </Button>
        </div>
      ) : !list ? (
        <Spinner />
      ) : !list.length ? (
        <Card>
          <EmptyState icon={<KeyRound />} title="Nog geen sleutels voor scripts">
            Geef een bot een sleutel bij de bot zelf: Bot › Sleutels voor scripts.
          </EmptyState>
        </Card>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {list.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
              <div className="min-w-[12rem] flex-1">
                <code className="font-medium">{k.name}</code>
                {k.label && <span className="text-muted"> · {k.label}</span>}
                <div className="text-xs text-muted">
                  {k.grants.length ? (
                    <>
                      {t('Krijgt hem:')}{' '}
                      {k.grants.map((g, i) => (
                        <span key={g.target + g.id}>
                          {i > 0 && ', '}
                          {g.target === 'agent' ? (
                            <a className="underline underline-offset-2 hover:text-fg" href={`#/a/${g.id}`}>
                              {g.name}
                            </a>
                          ) : (
                            t('team “{0}”', g.name)
                          )}
                          {g.blocked && <span className="text-warn"> ({g.blocked})</span>}
                        </span>
                      ))}
                    </>
                  ) : (
                    'Nog bij geen enkele bot'
                  )}
                  {' · '}
                  {k.last_used_at ? t('laatst gebruikt {0}', timeAgo(k.last_used_at)) : 'nog niet gebruikt'}
                </div>
              </div>
              {k.has_value ? <Badge tone="ok">opgeslagen</Badge> : <Badge tone="warn">geen waarde</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setRenew(k)}>
                Nieuwe waarde
              </Button>
              <Button size="icon" variant="ghost" aria-label={t('Sleutel {0} verwijderen', k.name)} onClick={() => remove(k)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {renew && <RenewModal k={renew} onClose={() => setRenew(null)} onSaved={() => (setRenew(null), load())} />}
    </section>
  );
}

/** Replace a key's value (write-only: the old one is never shown). */
function RenewModal({ k, onClose, onSaved }: { k: KeyView; onClose(): void; onSaved(): void }) {
  const [value, setValue] = useState('');
  const { busy, run } = useAsync();
  const save = async () => {
    await run(async () => {
      await api.patch(`/script-keys/${k.id}`, { value });
      toast('Nieuwe waarde opgeslagen', 'ok');
      onSaved();
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Nieuwe waarde voor {0}', k.name)}
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} disabled={!value.trim()} onClick={save}>
            Opslaan
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) save();
        }}
      >
        <Field label="Nieuwe sleutel of wachtwoord" hint="Vervangt de oude waarde voor alle bots die deze sleutel hebben. Wordt versleuteld bewaard en daarna nooit meer getoond.">
          <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" autoFocus />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
