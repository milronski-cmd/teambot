/** "knop “Bestellen”", "link “Factuur”", "veld “E-mail”": the element in words (never a page reference like e12). */
export function describeElement(info: any): string {
  if (!info) return '';
  const name = String(info.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const { tag = '', type = '', role = '' } = info;
  const kind =
    tag === 'a' || role === 'link'
      ? 'link'
      : tag === 'button' || role === 'button' || (tag === 'input' && /^(submit|button|image|reset)$/.test(type))
        ? 'knop'
        : tag === 'select'
          ? 'keuzelijst'
          : tag === 'input' && type === 'file'
            ? 'bestandsveld'
            : tag === 'input' || tag === 'textarea'
              ? 'veld'
              : 'element';
  return name ? `${kind} “${name}”` : kind === 'element' ? '' : `een ${kind}`;
}
