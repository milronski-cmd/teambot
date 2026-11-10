'use strict';
// Stand-in for node-webpmux (LGPL-3.0). whatsapp-web.js requires it at load time but only uses it in
// Util.formatToWebpSticker (sending stickers). TeamBot never sends stickers, so every use fails loudly
// instead of silently producing a broken file. See packages/node-webpmux-stub/README.md.

class Image {
  constructor() {
    throw new Error('Stickers maken wordt niet ondersteund in TeamBot (node-webpmux is bewust niet meegeleverd).');
  }
}

module.exports = { Image, TYPE_LOSSLESS: 0, TYPE_LOSSY: 1, TYPE_EXTENDED: 2 };
