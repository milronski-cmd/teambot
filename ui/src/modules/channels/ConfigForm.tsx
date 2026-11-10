import { useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw } from 'lucide-react';
import { Button, Field, Input, Select, Toggle, toast } from '../../components/ui';
import type { FieldDef, Guide } from './guides';
import { randomSecret } from './shared';

export function copy(text: string, what = 'Gekopieerd') {
  navigator.clipboard?.writeText(text).then(
    () => toast(what, 'ok'),
    () => toast('Kopiëren lukte niet — selecteer en kopieer handmatig', 'danger'),
  );
}

function SecretInput({ f, value, onChange, isSet }: { f: FieldDef; value: string; onChange(v: string): void; isSet: boolean }) {
  const [show, setShow] = useState(!!f.generate);
  return (
    <div className="flex gap-2">
      <Input
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={isSet ? 'Ingesteld — laat leeg om te behouden' : f.placeholder || ''}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
        aria-label={f.label}
      />
      {f.generate && (
        <>
          <Button type="button" size="icon" variant="secondary" aria-label="Nieuw geheim genereren" title="Nieuw geheim genereren" onClick={() => onChange(randomSecret(32))}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="secondary" aria-label="Kopiëren" title="Kopiëren" disabled={!value} onClick={() => copy(value)}>
            <Copy className="h-4 w-4" />
          </Button>
        </>
      )}
      {!f.generate && (
        <Button type="button" size="icon" variant="ghost" aria-label={show ? 'Verbergen' : 'Tonen'} title={show ? 'Verbergen' : 'Tonen'} onClick={() => setShow(!show)}>
          <KeyRound className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/** Renders a guide's fields. Secrets live in a separate object that is only ever sent, never loaded. */
export function ConfigForm({
  guide,
  config,
  onConfig,
  secrets,
  onSecrets,
  existingSecrets = {},
  advanced,
}: {
  guide: Guide;
  config: Record<string, any>;
  onConfig(c: Record<string, any>): void;
  secrets: Record<string, string>;
  onSecrets(s: Record<string, string>): void;
  existingSecrets?: Record<string, boolean>;
  advanced: boolean;
}) {
  const visible = guide.fields.filter((f) => (f.show ? f.show(config) : true) && (advanced || !f.advanced));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visible.map((f) => {
        const wide = f.kind === 'secret' || f.kind === 'toggle' || !!f.hint;
        const label = (
          <span className="inline-flex items-center gap-1.5">
            {f.label}
            {f.kind === 'secret' && existingSecrets[f.key] && (
              <span className="inline-flex items-center gap-0.5 text-xs font-normal text-ok">
                <Check className="h-3 w-3" /> ingesteld
              </span>
            )}
          </span>
        );
        if (f.kind === 'toggle')
          return (
            <div key={f.key} className="sm:col-span-2">
              <Toggle checked={config[f.key] !== false && config[f.key] !== undefined ? !!config[f.key] : false} onChange={(v) => onConfig({ ...config, [f.key]: v })} label={f.label} />
              {f.hint && <div className="mt-1 ps-11 text-xs text-muted">{f.hint}</div>}
            </div>
          );
        return (
          <Field key={f.key} label={label} hint={f.hint} className={wide ? 'sm:col-span-2' : ''}>
            {f.kind === 'secret' ? (
              <SecretInput f={f} value={secrets[f.key] || ''} isSet={!!existingSecrets[f.key]} onChange={(v) => onSecrets({ ...secrets, [f.key]: v })} />
            ) : f.kind === 'select' ? (
              <Select value={config[f.key] ?? ''} onChange={(e) => onConfig({ ...config, [f.key]: e.target.value })} aria-label={f.label}>
                {f.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={f.kind === 'number' ? 'number' : 'text'}
                value={config[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) => onConfig({ ...config, [f.key]: f.kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
                aria-label={f.label}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
