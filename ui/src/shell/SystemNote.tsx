import { Info } from 'lucide-react';
import { agentById } from '../lib/store';
import type { Message } from '../lib/types';
import { tKnown } from '../lib/format';
import { stripRefs } from '../lib/preview';
import { BotAvatar } from '../components/BotFace';
import { Words } from '../components/Words';
import { Markdown } from './Markdown';

/** What the second look said about a result, in the owner's words. */
const CHECK: Record<string, string> = {
  review: 'Tweede controle: nog nakijken',
  cant: 'Tweede controle: het lukte niet',
  passed: 'Tweede controle: in orde',
};
/** How one answer of a message to several bots ended, when there is no answer to show. */
const ENDED: Record<string, string> = {
  error: 'Niet gelukt',
  timeout: 'Niet op tijd klaar',
  cancelled: 'Gestopt',
  stopped: 'Gestopt door jou',
};

interface Answer {
  from: string;
  status?: string;
  said?: string;
  cut?: boolean;
  reason?: string;
}

/**
 * A note of TeamBot that has a view for the owner (`parts.note`, set where the note is made: rooms/orchestration.ts,
 * rooms/service.ts). The note's text is what the bot reads, with what it should do next and the tools to do it with;
 * the owner sees one calm line about what happened, in his language, and what a colleague answered as that bot's own
 * message, exactly as it wrote it (rendered markdown, never translated).
 * A TeamBot text in it (why it failed, what the second look said) is translated only when the dictionary has it
 * whole: a reason the reviewing model wrote stays as written.
 */
export function SystemNote({ m }: { m: Message }) {
  const p = m.parts;
  const answers: Answer[] = Array.isArray(p.answers) ? p.answers : p.said ? [{ from: p.from, said: p.said, cut: p.cut }] : [];
  return (
    <div className="space-y-1 py-2" data-testid="system-note" data-kind={p.kind}>
      <div className="flex justify-center px-4">
        <div className="flex max-w-xl items-start gap-1.5 rounded-control bg-surface-2 px-3 py-1 text-xs text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0">
            <Words text={p.note.text} values={p.note.values} />
            {p.reason && <span translate="no">{` · ${tKnown(p.reason)}`}</span>}
          </span>
        </div>
      </div>
      {answers.map((a, i) => (
        <Said key={i} a={a} threadId={p.threadId} />
      ))}
      {p.check?.state && CHECK[p.check.state] && (
        <p className="px-4 text-center text-xs text-muted">
          <span>{CHECK[p.check.state]}</span>
          {p.check.reason && <span translate="no">{` · ${tKnown(p.check.reason)}`}</span>}
        </p>
      )}
    </div>
  );
}

/** A colleague's answer, like its messages in the chat: its face, its name, what it wrote. */
function Said({ a, threadId }: { a: Answer; threadId?: string }) {
  const bot = agentById(a.from);
  return (
    <div className="flex gap-2.5 px-4 pt-2 sm:px-6">
      <BotAvatar bot={bot || { id: a.from, name: '' }} size={30} className="mt-0.5" />
      <div className="flex min-w-0 max-w-full flex-1 flex-col items-start sm:max-w-[85%]">
        <div className="flex items-baseline gap-2 px-1">
          <span className="text-[13px] font-bold" translate="no">
            {bot?.name || ''}
          </span>
          {!a.said && a.status && ENDED[a.status] && <span className="text-[11px] text-muted">{ENDED[a.status]}</span>}
        </div>
        {a.said && (
          <div className="w-full max-w-full py-1 text-[14.5px] leading-relaxed">
            <Markdown text={stripRefs(a.said)} />
          </div>
        )}
        {a.reason && (
          <p className="px-1 text-xs text-muted" translate="no">
            {tKnown(a.reason)}
          </p>
        )}
        {a.cut && threadId && (
          <a href={`#/t/${threadId}`} className="px-1 text-xs font-semibold text-muted underline-offset-2 hover:text-fg hover:underline">
            Ingekort: het hele antwoord staat in het gesprek van de taak
          </a>
        )}
      </div>
    </div>
  );
}
