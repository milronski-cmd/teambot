import { useEffect, useState } from 'react';
import { hasMath } from './math-text';

export { hasMath, prepareMath } from './math-text';

/**
 * Formulas in chat answers: KaTeX (MIT; its fonts are OFL-1.1 and ship with the app, never from a CDN) through
 * remark-math and rehype-katex (MIT). Loaded only when an answer contains a formula, as its own chunk with the KaTeX
 * stylesheet. KaTeX renders to plain elements (no raw HTML), with MathML for screen readers; `trust: false` keeps
 * \href, \includegraphics and the like off, and the size limits keep a hostile formula from freezing the page.
 */
export interface MathPlugins {
  remark: any[];
  rehype: any[];
}

let loading: Promise<MathPlugins> | null = null;
let ready: MathPlugins | null = null;

export function loadMath(): Promise<MathPlugins> {
  if (!loading)
    loading = Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')]).then(([remarkMath, rehypeKatex]) => {
      ready = {
        remark: [[remarkMath.default, { singleDollarTextMath: true }]],
        rehype: [[rehypeKatex.default, { strict: 'ignore', trust: false, maxSize: 50, maxExpand: 500, errorColor: 'currentColor' }]],
      };
      return ready;
    });
  return loading;
}


/** The math plugins once a text needs them (null while loading or without a formula). */
export function useMath(text: string): MathPlugins | null {
  const need = hasMath(text);
  const [plugins, setPlugins] = useState<MathPlugins | null>(ready);
  useEffect(() => {
    if (need && !plugins) loadMath().then(setPlugins, () => {});
  }, [need, plugins]);
  return need ? plugins || ready : null;
}
