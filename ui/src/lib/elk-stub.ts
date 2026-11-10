/**
 * Stand-in for elkjs in the interface bundle (see vite.config.ts). elkjs is licensed EPL-2.0 OR GPL-3.0, outside
 * TeamBot's license allowlist, and only serves Mermaid's optional "elk" layout: a diagram that asks for it fails to
 * draw and is shown as code instead.
 */
export default class ELK {
  constructor() {
    throw new Error('De ELK-layout van Mermaid zit niet in TeamBot');
  }
}
