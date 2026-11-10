import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDef } from '../../core/types.js';
import { registerAttachment } from './files.js';

const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'email'];

/** Tools every (non-chat) agent always has. */
export function coreTools(): ToolDef[] {
  return [
    {
      name: 'ask_user',
      group: 'core',
      risk: 'read',
      description:
        'Stel de gebruiker een vraag en wacht op het antwoord (bijv. bij onduidelijkheid of een keuze). Geef optioneel antwoordopties. Gebruik spaarzaam.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['question'],
      },
      summarize: (a) => String(a.question),
      async run(a, t) {
        const r = await t.ctx.broker.request({
          userId: t.thread.user_id,
          agent: t.agent,
          thread: t.thread,
          run: t.run,
          kind: 'question',
          tool: 'ask_user',
          input: a,
          summary: String(a.question),
          risk: 'read',
          options: Array.isArray(a.options) ? a.options.map(String).slice(0, 8) : undefined,
          signal: t.signal,
        });
        if (!r.approved) return 'De gebruiker wilde deze vraag niet beantwoorden.';
        return `Antwoord van de gebruiker: ${r.answer ?? '(leeg)'}`;
      },
    },
    {
      name: 'notify_user',
      group: 'core',
      risk: 'read',
      description: 'Stuur de gebruiker een korte melding (pushmelding op desktop/telefoon), bijv. als een lange taak klaar is.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['message'] },
      summarize: (a) => `Melding: ${a.message}`,
      async run(a, t) {
        t.ctx.events.emit(t.thread.user_id, 'notification', {
          title: String(a.title || t.agent.name),
          body: String(a.message).slice(0, 500),
          link: `#/t/${t.thread.id}`,
          kind: 'agent',
          agentId: t.agent.id,
        });
        return 'Melding verstuurd.';
      },
    },
    {
      name: 'ask_form',
      group: 'core',
      risk: 'read',
      description:
        'Vraag de gebruiker meerdere gegevens tegelijk via een formulier (bijv. naam, datum, keuze). Gebruik dit in plaats van veel losse vragen. Het antwoord komt terug als JSON.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Korte titel/uitleg boven het formulier' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                label: { type: 'string' },
                type: { type: 'string', enum: FIELD_TYPES },
                options: { type: 'array', items: { type: 'string' } },
                required: { type: 'boolean' },
                placeholder: { type: 'string' },
              },
              required: ['name', 'label'],
            },
          },
        },
        required: ['title', 'fields'],
      },
      summarize: (a) => String(a.title),
      async run(a, t) {
        const fields = (Array.isArray(a.fields) ? a.fields : []).slice(0, 20).map((f: any) => ({
          name: String(f.name || '').replace(/[^\w-]/g, '_').slice(0, 40) || 'veld',
          label: String(f.label || f.name || '').slice(0, 120),
          type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
          options: Array.isArray(f.options) ? f.options.map(String).slice(0, 20) : undefined,
          required: !!f.required,
          placeholder: f.placeholder ? String(f.placeholder).slice(0, 120) : undefined,
        }));
        if (!fields.length) return { text: 'Geen velden opgegeven.', isError: true };
        const r = await t.ctx.broker.request({
          userId: t.thread.user_id,
          agent: t.agent,
          thread: t.thread,
          run: t.run,
          kind: 'question',
          tool: 'ask_form',
          input: { title: String(a.title).slice(0, 500), fields },
          summary: String(a.title),
          risk: 'read',
          signal: t.signal,
        });
        if (!r.approved) return 'De gebruiker heeft het formulier niet ingevuld.';
        // Typed in the chat instead of filling in the form (agent/queue.ts): a plain answer, not JSON.
        let form = false;
        try {
          const v = JSON.parse(r.answer ?? '{}');
          form = !!v && typeof v === 'object' && !Array.isArray(v);
        } catch {
          /* plain text */
        }
        if (!form) return `De gebruiker vulde het formulier niet in, maar antwoordde in de chat: ${r.answer ?? '(leeg)'}`;
        return `Ingevuld formulier (JSON): ${r.answer ?? '{}'}`;
      },
    },
    {
      name: 'show_html',
      group: 'core',
      risk: 'read',
      description:
        'Toon de gebruiker een interactieve HTML-preview in de chat (bijv. een mini-app, grafiek, ontwerp of tabel). Volledige HTML met inline CSS/JS; externe bestanden en netwerk zijn geblokkeerd. De preview draait afgeschermd.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, html: { type: 'string', description: 'Complete HTML-pagina' } },
        required: ['title', 'html'],
      },
      summarize: (a) => `Preview: ${a.title}`,
      async run(a, t) {
        const html = String(a.html || '');
        if (!html.trim()) return { text: 'Lege HTML.', isError: true };
        if (html.length > 500_000) return { text: 'HTML is te groot (max 500 kB).', isError: true };
        const name = (String(a.title || 'preview').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'preview') + '.html';
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-html-')), name);
        fs.writeFileSync(tmp, html);
        const ref = registerAttachment(t.ctx, t.thread.user_id, t.thread.id, tmp, name, false);
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
        return { text: `Preview getoond aan de gebruiker: ${ref.name}`, attachments: [ref] };
      },
    },
  ];
}
