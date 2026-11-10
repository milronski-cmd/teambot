import { useEffect, useState, type ReactNode } from 'react';
import { svgSize } from '../lib/mermaidBlock';

/**
 * A ```mermaid block drawn as a diagram. The mermaid library is loaded only when such a block appears (its own chunk),
 * runs with securityLevel "strict" (labels sanitized, no click handlers or scripts) and without HTML labels, and the
 * resulting SVG is shown as an <img> from a data URL: an image cannot run scripts or load anything from the network.
 * While it renders, or when the diagram cannot be drawn, the normal code block is shown (`fallback`).
 */

type Mermaid = typeof import('mermaid').default;

let loader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!loader) {
    loader = import('mermaid').then((m) => m.default);
    loader.catch(() => {
      loader = null;
    });
  }
  return loader;
}

/** mermaid keeps global state: one render at a time. */
let chain: Promise<unknown> = Promise.resolve();
let seq = 0;

/** Remove what mermaid may leave in <body> after a (failed) render. */
function cleanup(id: string) {
  for (const x of [id, 'd' + id, 'i' + id]) document.getElementById(x)?.remove();
}

export async function renderMermaid(code: string, dark: boolean): Promise<string | null> {
  const run = async (): Promise<string | null> => {
    const mermaid = await loadMermaid();
    // layout "dagre": mermaid 12 defaults to the ELK layout, whose library (elkjs, EPL-2.0/GPL-3.0) TeamBot does not
    // ship (vite.config.ts); a diagram that asks for ELK itself is shown as code.
    const config: Parameters<Mermaid['initialize']>[0] & Record<string, unknown> = {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      layout: 'dagre',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      state: { layout: 'dagre' },
      cynefin: { layout: 'dagre' },
      suppressErrorRendering: true,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    };
    mermaid.initialize(config);
    const id = `tb-mermaid-${Date.now().toString(36)}-${++seq}`;
    try {
      if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
      const { svg } = await mermaid.render(id, code);
      return /^\s*<svg[\s>]/i.test(svg) ? svg : null;
    } catch {
      return null;
    } finally {
      cleanup(id);
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => null);
  return p;
}

function useDarkTheme(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const dark = useDarkTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showCode, setShowCode] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    // A short pause: an answer that is still coming in does not redraw on every word.
    const t = setTimeout(() => {
      renderMermaid(code, dark)
        .then((s) => {
          if (!alive) return;
          setSvg(s);
          setFailed(!s);
        })
        .catch(() => alive && setFailed(true));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [code, dark]);

  if (failed || !svg) return <>{fallback}</>;
  const size = svgSize(svg);
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return (
    <figure className="my-2">
      <div className="mb-1 flex items-center justify-end gap-2 text-[11px] text-muted">
        <span>diagram</span>
        <button type="button" className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-muted hover:text-fg" aria-pressed={showCode} onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Diagram tonen' : 'Code tonen'}
        </button>
      </div>
      {showCode ? (
        fallback
      ) : (
        <div className="max-w-full overflow-x-auto rounded-lg border border-line bg-surface p-2">
          <img src={src} alt="Diagram" className="block h-auto max-w-full" style={size ? { width: size.width, aspectRatio: `${size.width} / ${size.height}` } : undefined} draggable={false} />
        </div>
      )}
    </figure>
  );
}
