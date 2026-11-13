import { useId, useState } from 'react';
import { ChevronRight, Crown } from 'lucide-react';
import { askConfirm, Button, Spinner, cx, toast, toastError } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { BotAvatar } from '../../components/BotFace';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { teamsApi, useMainBot } from './api';

/**
 * The main bot (hoofdbot, package C): there is always exactly one; TeamBot picks the first bot by itself and the owner
 * can hand the role to another bot. Nothing here has to be chosen before bots work. These parts are self-contained, so the
 * shell and the new-bot flow only mount them:
 *  - MainBotChoice   "Gewone bot of hoofdbot" in the new-bot flow (`<MainBotChoice agent={draft} onChange={set} />`);
 *  - MainBotSection  the bot editor section "Hoofdbot" (make this bot the main bot, or a normal bot again);
 *  - MainBotEntry    the main bot on top of the phone's chat list (the front door).
 */

const strip = (s: Record<string, any> | undefined) => {
  const { mainBot: _m, ...rest } = s || {};
  return rest;
};

/**
 * "Gewone bot of hoofdbot" while making a bot. Choosing "Hoofdbot" asks the server for a single-use token that goes
 * into the new bot's `settings.mainBot`; the server makes that bot the main bot when it is created (and drops the
 * token from the bot). With a main bot already there, it only says which one that is.
 */
export function MainBotChoice({ agent, onChange }: { agent: Partial<Agent>; onChange(patch: Partial<Agent>): void }) {
  const main = useMainBot();
  const name = useId();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (main === undefined) return null;
  if (main && main.id !== agent.id) return <p className="text-xs text-muted">{t('Je hoofdbot is {0}. Deze bot wordt een gewone bot.', main.name)}</p>;
  const chosen = typeof agent.settings?.mainBot === 'string';
  const pick = async (v: 'main' | 'normal') => {
    setErr('');
    if (v === 'normal') return onChange({ settings: strip(agent.settings) });
    setBusy(true);
    try {
      const r = await teamsApi.mainIntent();
      onChange({ settings: { ...strip(agent.settings), mainBot: r.token } });
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const option = (v: 'main' | 'normal', title: string, text: string) => {
    const on = v === 'main' ? chosen : !chosen;
    return (
      <label className={cx('flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors', on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}>
        <input type="radio" name={name} className="mt-1 shrink-0" checked={on} disabled={busy} onChange={() => pick(v)} />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted">{text}</span>
        </span>
      </label>
    );
  };
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-semibold">Soort bot</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {option('normal', 'Gewone bot', 'Doet zelf het werk waarvoor je hem maakt, in zijn team.')}
        {option('main', 'Hoofdbot', 'Je vaste voordeur: hij verdeelt het werk. Er is er maar één.')}
      </div>
      {busy && <Spinner className="mt-2" />}
      {err && <p className="mt-1.5 text-xs text-danger">{err}</p>}
    </fieldset>
  );
}

/** Bot editor section "Hoofdbot": this bot is the main bot, another one is, or it can become the main bot. */
export function MainBotSection({ agent }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const main = useMainBot();
  const [busy, setBusy] = useState(false);
  // A new bot: the choice sits in the new-bot flow itself (MainBotChoice, "Soort bot").
  if (!agent.id) return <p className="text-sm text-muted">{typeof agent.settings?.mainBot === 'string' ? 'Deze bot wordt je hoofdbot.' : 'Kies bij ‘Soort bot’ of deze bot je hoofdbot wordt.'}</p>;
  if (main === undefined) return <Spinner />;
  const make = async () => {
    const text = main ? t('{0} wordt je hoofdbot en {1} wordt een gewone bot. Is {0} teamleider, dan is hij dat daarna niet meer.', agent.name, main.name) : t('{0} wordt je hoofdbot. Is {1} teamleider, dan is hij dat daarna niet meer.', agent.name, agent.name);
    if (!(await askConfirm(text, { ok: 'Hoofdbot maken' }))) return;
    setBusy(true);
    try {
      const r = await teamsApi.setMain(agent.id);
      toast(t('{0} is nu je hoofdbot', agent.name), 'ok');
      for (const n of r.notes) toast(n);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (main?.id === agent.id)
    return (
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-sm">
          <Crown className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span>{t('{0} is je hoofdbot: je vaste voordeur. Hij geeft de teams werk, controleert het en meldt terug.', agent.name)}</span>
        </p>
        <p className="text-sm text-muted">Er is altijd één hoofdbot. Wil je een andere, open dan die bot en maak hem hoofdbot.</p>
        <a className="text-sm font-semibold text-accent hover:underline" href="#/m/teams/alle">
          Alle teams bekijken
        </a>
      </div>
    );
  if (main)
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('Je hoofdbot is {0}. Er is er altijd één.', main.name)}</p>
        <Button size="sm" icon={<Crown className="h-4 w-4" />} loading={busy} onClick={make}>
          {t('{0} hoofdbot maken', agent.name)}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Je hebt nog geen hoofdbot.{' '}
        <MoreInfo>Je vaste voordeur: hij geeft het werk aan de juiste bot of het juiste team.</MoreInfo>
      </p>
      <Button size="sm" icon={<Crown className="h-4 w-4" />} loading={busy} onClick={make}>
        {t('{0} hoofdbot maken', agent.name)}
      </Button>
    </div>
  );
}
