# node-webpmux (TeamBot stand-in)

`whatsapp-web.js` (Apache-2.0) depends on `node-webpmux`, which is LGPL-3.0. That licence is outside the
allowlist in `scripts/notices.mjs`, so `package.json` replaces it through `overrides` with this package.

`whatsapp-web.js` loads `node-webpmux` at start-up but only uses it to turn images into stickers
(`Util.formatToWebpSticker`). TeamBot never sends stickers. Creating an `Image` throws a clear error,
so a future code path that does need stickers fails loudly instead of sending a broken file.

The same `overrides` block swaps `puppeteer` for `puppeteer-core` (identical API, no Chrome download):
TeamBot starts the Edge or Chrome that is already installed on the computer.
