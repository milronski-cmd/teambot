/**
 * Copy text, also where the clipboard API is missing or refused: a phone that opens TeamBot over plain http (no secure
 * context, so no navigator.clipboard) or a browser that denies the permission. Falls back to a hidden text field.
 * Resolves true when the text is on the clipboard; never throws (acceptance round 5: "Kopiëren" under a message did
 * nothing on such a page and left an unhandled error).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
