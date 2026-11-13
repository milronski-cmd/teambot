import { Fragment, useSyncExternalStore } from 'react';
import { dictionaryLoaded, onDictionary, tOwn } from '../lib/i18n';
import type { WordsValue } from '../lib/i18n-core';

/**
 * TeamBot's words with someone's own words in them: a Dutch template and its values ("Gesprek “{0}” nalezen voor het
 * geheugen" + a chat title). The template is shown in the interface language, every text value exactly as written.
 * The whole is translated here, so it carries translate="no": the page translator (lib/i18n.ts) leaves it alone and
 * never translates the user's words inside it. Rendered again once the dictionary is there.
 */
export function Words({ text, values = [], className }: { text: string; values?: WordsValue[]; className?: string }) {
  useSyncExternalStore(onDictionary, dictionaryLoaded);
  return (
    <span translate="no" className={className}>
      {tOwn(text, ...values).map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <bdi key={i}>{p.own}</bdi>))}
    </span>
  );
}
