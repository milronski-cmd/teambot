import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Thread, ToolDef } from '../../core/types.js';
import { mimeOf, refuseReadOf, resolveInWorkspace } from '../../tools/builtin/files.js';
import { preview } from './format.js';
import { OWNER_TARGETS, type ChannelManager } from './manager.js';
import type { Binding, OutFile } from './types.js';
import { words } from '../../../shared/i18n-core.js';

export const CHANNEL_GROUP = 'channels';
const MAX_FILES = 10;

function findBinding(m: ChannelManager, list: Binding[], ref: any): Binding | null {
  const r = String(ref || '').trim();
  if (!r) return list.length === 1 ? list[0] : null;
  return list.find((b) => b.id === r) || list.find((b) => b.name.toLowerCase() === r.toLowerCase()) || list.find((b) => b.adapter === r.toLowerCase()) || null;
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/**
 * Files for channel_send: only from the bot's own workspace or its extra (shared) folders, never secrets,
 * within the channel's size limit. Returns an error text for the bot instead of throwing.
 */
export function pickFiles(m: ChannelManager, agent: Agent, b: Binding, list: any): { files: OutFile[]; error?: string } {
  const paths: string[] = (Array.isArray(list) ? list : list ? [list] : []).map((x: any) => String(x || '').trim()).filter(Boolean);
  if (paths.length > MAX_FILES) return { files: [], error: `Maximaal ${MAX_FILES} bestanden per bericht.` };
  const maxBytes = m.maxFileBytes(b);
  const files: OutFile[] = [];
  for (const p of paths) {
    let abs: string;
    try {
      abs = resolveInWorkspace(agent, p);
    } catch (e: any) {
      return { files: [], error: `${e?.message || e} Alleen bestanden uit je werkmap of gedeelde map kunnen mee.` };
    }
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return { files: [], error: `Bestand niet gevonden: ${p}` };
    if (st.size === 0) return { files: [], error: `Bestand is leeg: ${p}` };
    if (st.size > maxBytes) return { files: [], error: `${path.basename(abs)} is ${fmtSize(st.size)}; via “${b.name}” kan maximaal ${fmtSize(maxBytes)}.` };
    const name = path.basename(abs);
    files.push({ name, mime: mimeOf(name), path: abs, size: st.size });
  }
  return { files };
}

/**
 * Tools for bots that have channel bindings. Sending is `danger` (the owner approves each message), except for
 * targets the owner pre-approved for this bot: himself, or a contact he trusts (then `write`, so it still follows
 * the bot's access mode). Those rules live in channel_send_rules and are only set by the owner through the API.
 */
export function channelTools(ctx: Ctx, m: ChannelManager) {
  return (agent: Agent, thread: Thread): ToolDef[] => {
    const list = m.bindingsForAgent(agent, thread);
    // Teams (package B4): channels of teams this bot may look into, shown in channel_list only (never for sending).
    const seen = m.readOnlyBindingsFor(agent, thread);
    if (!list.length && !seen.length) return [];
    const names = list.map((b) => `“${b.name}” (${m.def(b)?.label || b.adapter}, id ${b.id})`).join(', ') || '(geen: je team heeft geen kanalen)';
    const seenNames = seen.map((b) => `“${b.name}” (${m.def(b)?.label || b.adapter}, team “${m.teams.teamName(m.teams.teamOf(b))}”, alleen meekijken)`).join(', ');
    /**
     * A channel this bot may not send through: another team's, with the reason when the bot may look into that team,
     * otherwise as if it does not exist (a team without access is never named). Null for its own channels.
     */
    const wallFor = (ref: any): string | null => {
      const r = String(ref || '').trim();
      if (!r || findBinding(m, m.bindingsForAgent(agent, thread), r)) return null;
      const other = findBinding(m, m.bindings(agent.user_id), r);
      if (!other) return null;
      return m.teams.readable(agent, other) ? m.teams.refusal(agent, other) : `Geen kanaal “${r}” dat ${agent.name} mag gebruiken. Beschikbaar: ${names}`;
    };
    const describeTarget = (args: any) => {
      const b = findBinding(m, list, args?.binding);
      if (!b) return { b, label: words('onbekend kanaal'), to: String(args?.to || '?') };
      const t = m.classifyTarget(b, String(args?.to || ''));
      const to = t.owner ? words('jou (eigenaar)') : t.conv?.title ? `${t.conv.title} (${args?.to})` : String(args?.to || '?');
      return { b, label: `${m.def(b)?.label || b.adapter} “${b.name}”`, to };
    };
    const ownerFree = m.sendRules(agent.id).some((r) => r.target === 'owner');
    return [
      {
        name: 'channel_list',
        group: CHANNEL_GROUP,
        risk: 'read',
        description: `Toon je gekoppelde kanalen (${names}) en de bekende gesprekken daarin, om een ontvanger voor channel_send te kiezen.${seenNames ? ` Ook kanalen van andere teams waar je mag meekijken (alleen bekijken, niet versturen): ${seenNames}.` : ''}`,
        parameters: { type: 'object', properties: { binding: { type: 'string', description: 'Naam of id van de koppeling (optioneel)' } } },
        summarize: () => words('Kanalen en gesprekken bekijken'),
        async run(args) {
          const all = [...list, ...seen];
          const sel = args?.binding ? ([findBinding(m, all, args.binding)].filter(Boolean) as Binding[]) : all;
          if (!sel.length) return { text: `Onbekende koppeling. Beschikbaar: ${names}`, isError: true };
          const out: string[] = [];
          for (const b of sel) {
            if (!list.includes(b)) {
              // Another team's channel this bot may look into: what is there, never a way to send.
              out.push(`## ${b.name} — ${m.def(b)?.label || b.adapter} (team “${m.teams.teamName(m.teams.teamOf(b))}”, alleen meekijken: versturen via dit kanaal kan niet)`);
              const convs = m.conversations(b.id).filter((c) => !c.meta?.agentId).slice(0, 30);
              if (!convs.length) out.push('(nog geen gesprekken)');
              for (const c of convs) out.push(`- ${c.title}${c.is_private ? ' (privé)' : ' (groep)'}${c.last_inbound_at ? `, laatst ${c.last_inbound_at.slice(0, 16).replace('T', ' ')}` : ''}`);
              continue;
            }
            const free = m.sendRules(agent.id).filter((r) => r.target !== 'owner' && r.binding_id === b.id);
            out.push(`## ${b.name} — ${m.def(b)?.label || b.adapter} (id ${b.id}, status ${b.status}, max ${fmtSize(m.maxFileBytes(b))} per bestand)`);
            out.push(`- Jij aan je eigenaar: to="eigenaar"${m.sendAllowed(agent.id, b, { owner: true, ext: 'owner' }) ? ' (mag zonder te vragen)' : ' (vraagt toestemming)'}`);
            const convs = m.conversations(b.id).filter((c) => !c.meta?.agentId).slice(0, 30);
            if (!convs.length) out.push('(nog geen gesprekken)');
            for (const c of convs) {
              const owner = m.isOwnerConversation(b, c);
              const ok = owner ? false : free.some((r) => r.target === (c.meta?.baseExternalId || c.external_id));
              out.push(`- ${c.title} — gesprek-id ${c.id}${c.is_private ? ' (privé)' : ' (groep)'}${owner ? ' (je eigenaar)' : ''}${ok ? ' (mag zonder te vragen)' : ''}${c.last_inbound_at ? `, laatst ${c.last_inbound_at.slice(0, 16).replace('T', ' ')}` : ''}`);
            }
          }
          return out.join('\n');
        },
      },
      ...(list.length ? [sendTool()] : []),
    ];

    function sendTool(): ToolDef {
      return {
        name: 'channel_send',
        group: CHANNEL_GROUP,
        risk: 'danger',
        description:
          `Stuur een NIEUW bericht, eventueel met bestanden (pdf, afbeeldingen, documenten uit je werkmap of gedeelde map), via een gekoppeld kanaal. ` +
          `Gebruik to="eigenaar" om je eigenaar zelf te bereiken (bijv. een rapport naar zijn WhatsApp)${ownerFree ? ' — dat mag zonder te vragen' : ''}. ` +
          'Je gewone antwoord in een kanaalgesprek gaat al automatisch terug; gebruik dit voor iemand anders of een ander kanaal. ' +
          'Berichten aan anderen vragen toestemming van je eigenaar, tenzij hij die ontvanger voor jou heeft vrijgegeven.',
        parameters: {
          type: 'object',
          properties: {
            binding: { type: 'string', description: `Koppeling (naam of id). Beschikbaar: ${names}` },
            to: {
              type: 'string',
              description:
                '"eigenaar" voor je eigenaar zelf; of een gesprek-id uit channel_list; of een adres: e-mailadres, Telegram-chat-id, Slack-kanaal/gebruiker-id, Discord user:<id>/channel:<id>, WhatsApp-nummer (31612345678)',
            },
            text: { type: 'string', description: 'De tekst van het bericht (Markdown mag). Mag leeg als je alleen bestanden stuurt.' },
            files: { type: 'array', items: { type: 'string' }, description: `Optioneel: paden van bestanden in je werkmap of gedeelde map (max ${MAX_FILES}), bijv. ["rapporten/dagrapport.pdf"]` },
            subject: { type: 'string', description: 'Alleen e-mail: onderwerp voor een nieuw gesprek' },
          },
          required: ['to'],
        },
        riskFor(args, t) {
          const b = findBinding(m, m.bindingsForAgent(t.agent, t.thread), args?.binding);
          if (!b || !args?.to) return 'danger';
          // Customer mode: money, promises or anything outside the approved knowledge always waits for the owner,
          // also for a contact he released for this bot.
          if (m.customerSendNeedsApproval(b, String(args.to), String(args?.text || ''))) return 'danger';
          return m.sendAllowed(t.agent.id, b, m.classifyTarget(b, String(args.to))) ? 'write' : 'danger';
        },
        // "Volledige toegang": a message to the owner himself is normal work; anyone else stays external (asks,
        // unless the owner also allowed sending to others without asking).
        impact: (args) => (OWNER_TARGETS.has(String(args?.to || '').trim().toLowerCase()) ? 'local' : 'external'),
        summarize: (a) => {
          const d = describeTarget(a);
          const files = (Array.isArray(a?.files) ? a.files : a?.files ? [a.files] : []).map((f: any) => path.basename(String(f)));
          const txt = String(a?.text || '').trim();
          // To a customer the owner approves the exact text, not a preview.
          const full = !!d.b && m.customerOn(d.b) && !m.classifyTarget(d.b, String(a?.to || '')).owner;
          const msg = words('Bericht via {0} naar {1}: {2}', d.label, d.to, txt ? words('“{0}”', full ? txt.slice(0, 1500) : preview(txt, 160)) : words('(geen tekst)'));
          if (!files.length) return msg;
          return words('{0} + {1, plural, one {# bestand} other {# bestanden}}: {2}', msg, files.length, `${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`);
        },
        // Another team's channel: refused before an approval card (approving could never make it allowed).
        refuse: (args, t) => wallFor(args?.binding) || refuseReadOf('files')(args, t),
        async run(args, t) {
          const wall = wallFor(args.binding);
          if (wall) return { text: wall, isError: true };
          const b = findBinding(m, list, args.binding);
          if (!b) return { text: `Kies een koppeling met "binding". Beschikbaar: ${names}`, isError: true };
          const fresh = m.binding(b.id);
          if (!fresh || fresh.user_id !== t.userId || !fresh.enabled) return { text: 'Deze koppeling is niet actief.', isError: true };
          // The channel's team at the moment of sending (a bot may have moved since the tool list was made).
          const moved = m.teams.refusal(t.agent, fresh);
          if (moved) return { text: moved, isError: true };
          const text = String(args.text || '').slice(0, 20_000);
          const picked = pickFiles(m, t.agent, fresh, args.files);
          if (picked.error) return { text: picked.error, isError: true };
          if (!text.trim() && !picked.files.length) return { text: 'Lege tekst en geen bestanden.', isError: true };
          const to = String(args.to).trim();
          const target = m.classifyTarget(fresh, to);
          const out = { text, files: picked.files, subject: args.subject ? String(args.subject).slice(0, 200) : undefined, senderName: t.agent.name };
          try {
            const r = OWNER_TARGETS.has(to.toLowerCase()) ? await m.sendToOwner(fresh, out) : await m.sendNew(fresh, to, out);
            ctx.audit(
              t.userId,
              'channels.send',
              {
                binding: b.id,
                adapter: b.adapter,
                to: to.slice(0, 200),
                owner: target.owner,
                preApproved: m.sendAllowed(t.agent.id, fresh, target),
                conversation: r.conversationId,
                preview: preview(text, 80),
                files: picked.files.map((f) => ({ name: f.name, size: f.size })),
              },
              t.agent.id,
            );
            const fl = picked.files.length ? ` met ${picked.files.length === 1 ? '1 bestand' : `${picked.files.length} bestanden`} (${picked.files.map((f) => `${f.name}, ${fmtSize(f.size)}`).join('; ')})` : '';
            return `Verstuurd via ${m.def(b)?.label} naar ${target.owner ? 'je eigenaar' : r.title}${fl} (gesprek-id ${r.conversationId}).`;
          } catch (e: any) {
            return { text: `Versturen mislukt: ${e?.message || e}`, isError: true };
          }
        },
      };
    }
  };
}
