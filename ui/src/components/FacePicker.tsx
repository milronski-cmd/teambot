import { useRef, useState } from 'react';
import { ImagePlus, Shuffle, X } from 'lucide-react';
import { COLORS, EXTRAS, EYES, FACE_LABELS, MOODS, MOOD_LABELS, PALETTE, SHAPES, MOUTHS, encodeFace, isImageAvatar, parseFace, randomTraits, traitsFor, type FaceTraits } from '../lib/botface';
import { BotAvatar, BotFace } from './BotFace';
import { Button, Toggle, cx, toastError } from './ui';

/** Shrink an uploaded picture to a small square JPEG data URL (keeps the agents list light). */
async function toSmallDataUrl(file: File, px = 160): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Kies een afbeelding (PNG, JPG, WebP).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('Afbeelding kon niet worden gelezen'));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const s = Math.min(img.width, img.height);
    c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, px, px);
    return c.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Part = 'shape' | 'color' | 'eyes' | 'mouth' | 'extra';
const PARTS: { key: Part; label: string; values: readonly string[] }[] = [
  { key: 'shape', label: 'Vorm', values: SHAPES },
  { key: 'color', label: 'Kleur', values: COLORS },
  { key: 'eyes', label: 'Ogen', values: EYES },
  { key: 'mouth', label: 'Mond', values: MOUTHS },
  { key: 'extra', label: 'Extra', values: EXTRAS },
];

/**
 * "Gezicht" in the bot editor: pick shape, colour, eyes, mouth and an extra with a live preview, or let TeamBot pick
 * one at random. An uploaded picture still works. Writes `face:{json}` (or the picture) into the bot's avatar.
 */
export function FacePicker({ seed, name, avatar, onChange }: { seed: string; name: string; avatar: string; onChange(avatar: string, color?: string): void }) {
  const file = useRef<HTMLInputElement>(null);
  const [part, setPart] = useState<Part>('shape');
  const photo = isImageAvatar(avatar);
  const t: FaceTraits = traitsFor(seed, parseFace(avatar) || {});
  const set = (patch: Partial<FaceTraits>) => {
    const next = { ...t, ...patch };
    onChange(encodeFace(next), (PALETTE as Record<string, string>)[next.color] || undefined);
  };
  const cur = PARTS.find((p) => p.key === part)!;
  const optionLabel = (k: Part, v: string) => (FACE_LABELS[k] as Record<string, string>)[v] || v;

  return (
    <div className="grid gap-5 sm:grid-cols-[176px_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface-2 p-4">
        <BotAvatar bot={{ id: seed, name, avatar }} size={112} />
        <div className="flex justify-center gap-[3px]" role="img" aria-label="Zo ziet hij eruit per stemming">
          {!photo &&
            MOODS.map((m) => (
              <span key={m} title={MOOD_LABELS[m]} className="flex flex-col items-center">
                <BotFace seed={seed} traits={t} mood={m} size={20} />
                <span className="sr-only">{MOOD_LABELS[m]}</span>
              </span>
            ))}
        </div>
        <div className="flex w-full flex-col gap-1.5">
          <Button size="sm" className="justify-center" icon={<Shuffle className="h-3.5 w-3.5" />} onClick={() => set(randomTraits())}>
            Willekeurig
          </Button>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                onChange(await toSmallDataUrl(f));
              } catch (err) {
                toastError(err);
              }
            }}
          />
          {photo ? (
            <Button size="sm" variant="ghost" className="justify-center" icon={<X className="h-3.5 w-3.5" />} onClick={() => set({})}>
              Foto weghalen
            </Button>
          ) : (
            <Button size="sm" variant="ghost" className="justify-center" icon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => file.current?.click()}>
              Eigen foto
            </Button>
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Onderdeel van het gezicht">
          {PARTS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={part === p.key}
              onClick={() => setPart(p.key)}
              className={cx('h-8 shrink-0 rounded-full px-3.5 text-[13px] coarse:h-10', part === p.key ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg')}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5" role="group" aria-label={cur.label}>
          {cur.values.map((v) => {
            const on = !photo && t[cur.key] === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                aria-label={`${cur.label}: ${optionLabel(cur.key, v)}`}
                title={optionLabel(cur.key, v)}
                onClick={() => set({ [cur.key]: v } as Partial<FaceTraits>)}
                className={cx('flex flex-col items-center gap-1 rounded-xl border p-1.5 pb-1 transition-colors', on ? 'border-fg bg-surface-3' : 'border-transparent bg-surface-2 hover:bg-surface-3')}
              >
                <BotFace seed={seed} traits={{ ...t, [cur.key]: v }} size={44} />
                <span className="w-full truncate text-center text-[11px] font-medium text-muted">{optionLabel(cur.key, v)}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <Toggle checked={!photo && t.cheeks} disabled={photo} onChange={(v) => set({ cheeks: v })} label="Blosjes" />
        </div>
      </div>
    </div>
  );
}
