import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { User, Role } from './types.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (what = 'Niet gevonden') => new HttpError(404, what);
export const forbidden = (msg = 'Geen toegang') => new HttpError(403, msg);

/** Wrap async handlers so thrown errors reach the error middleware. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => any): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next))
      .then((out) => {
        if (out !== undefined && !res.headersSent) res.json(out);
      })
      .catch(next);
  };
}

/**
 * Send one of TeamBot's own files (a browser frame, a preview, recorded or spoken audio, a download). The data folder
 * may lie under a folder whose name starts with a dot (~/.local/share/teambot on Linux, a trial or test folder under
 * .data\): Express refuses such a path by default with a 404, so every frame and audio file was "not found" there.
 * Resolves once the file is sent; rejects (for the error middleware) when it could not be sent and nothing went out.
 */
export function sendOwnFile(res: Response, file: string, opts: { headers?: Record<string, string>; lastModified?: boolean; acceptRanges?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => res.sendFile(file, { ...opts, dotfiles: 'allow' }, (err: any) => (err && !res.headersSent ? reject(err) : resolve())));
}

export function user(req: Request): User {
  const u = (req as any).user as User | undefined;
  if (!u) throw new HttpError(401, 'Niet ingelogd');
  return u;
}

const rank: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export function requireRole(req: Request, role: Role) {
  const u = user(req);
  if (rank[u.role] < rank[role]) throw forbidden('Alleen voor ' + role);
  return u;
}

/** Ensure the resource belongs to the requesting user. */
export function own<T extends { user_id: string }>(req: Request, obj: T | null | undefined, what = 'Niet gevonden'): T {
  const u = user(req);
  if (obj && obj.user_id !== u.id && (obj as any).settings?.shared === true && typeof (obj as any).access_mode === 'string') {
    // Someone else's bot that is shared with the team (agent/shared.ts): say plainly why, instead of "not found".
    throw forbidden(`${(obj as any).name} is een gedeelde bot van iemand anders. Alleen de eigenaar kan dit doen; jij kunt ermee praten in je eigen gesprekken.`);
  }
  if (!obj || obj.user_id !== u.id) throw notFound(what);
  return obj;
}

export function str(v: any, max = 100_000): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}
