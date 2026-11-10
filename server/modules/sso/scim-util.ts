import type { Request, Response } from 'express';

/** Shared SCIM 2.0 bits (RFC 7643/7644) for the Users and Groups endpoints. */

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const MAX_COUNT = 200;

export class ScimError extends Error {
  constructor(public status: number, detail: string, public scimType?: string) {
    super(detail);
  }
}

export function send(res: Response, status: number, body?: any) {
  res.status(status);
  if (body === undefined) return void res.end();
  res.type('application/scim+json').send(JSON.stringify(body));
}

export const toBool = (v: any): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  return undefined;
};
export const clean = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

/** `attribute eq "value"` → [attribute (lower case, spaces collapsed), value]; anything else is invalidFilter. */
export function parseEqFilter(raw: unknown): [string, string] | null {
  const filter = typeof raw === 'string' ? raw.trim() : '';
  if (!filter) return null;
  const f = /^([A-Za-z.[\]" ]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(filter);
  if (!f) throw new ScimError(400, 'Alleen filters van de vorm attribuut eq "waarde" worden ondersteund', 'invalidFilter');
  return [f[1].trim().toLowerCase().replace(/\s+/g, ' '), f[2].replace(/\\(.)/g, '$1')];
}

/** startIndex (1-based) and count (default 100, max 200) from the query. */
export function paging(req: Request): { startIndex: number; count: number } {
  const startIndex = Math.max(1, Math.floor(Number(req.query.startIndex) || 1));
  const count = req.query.count === undefined ? 100 : Math.max(0, Math.min(MAX_COUNT, Math.floor(Number(req.query.count) || 0)));
  return { startIndex, count };
}

/** Should an optional attribute be returned, given `attributes` / `excludedAttributes` (RFC 7644 §3.9)? */
export function wantAttr(req: Request, name: string): boolean {
  const list = (v: unknown) =>
    String(typeof v === 'string' ? v : '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const n = name.toLowerCase();
  const only = list(req.query.attributes);
  if (only.length && !only.some((a) => a === n || a.startsWith(n + '.') || a.endsWith(':' + n))) return false;
  return !list(req.query.excludedAttributes).some((a) => a === n || a.endsWith(':' + n));
}
