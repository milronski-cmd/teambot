import type { Request } from 'express';
import type { Ctx } from '../../core/types.js';
import { ah, own, str, user } from '../../core/http.js';
import { HttpLike } from './service.js';
import type { VaultRow, VaultService } from './vault.js';

/**
 * Login vault API (registered before the generic /computers/:agentId routes). Only your own entries. Passwords and
 * TOTP secrets are write-only: they come in once and never go out again (answers say has_password / has_totp).
 * Not opted in for paired phones: managing logins happens on the computer.
 */
export function vaultRoutes(ctx: Ctx, vault: VaultService) {
  const api = ctx.api;
  const entryOf = (req: Request): VaultRow => own(req, vault.row(String(req.params.id)), 'Login niet gevonden');
  const noDevice = (req: Request) => {
    if ((req as any).session?.kind === 'device') throw new HttpLike(403, 'De kluis beheer je op je computer.');
  };

  api.get(
    '/computers/vault',
    ah(async (req) => {
      noDevice(req);
      return vault.list(user(req).id);
    }),
  );
  api.post(
    '/computers/vault',
    ah(async (req) => {
      noDevice(req);
      return vault.create(user(req), req.body || {});
    }),
  );
  /**
   * CSV import: the file text arrives once in the request body and is parsed in memory (never written to disk);
   * the preview answers names, sites and usernames only, the import answers counts and reasons.
   */
  api.post(
    '/computers/vault/import/preview',
    ah(async (req) => {
      noDevice(req);
      return vault.importPreview(user(req), req.body || {});
    }),
  );
  api.post(
    '/computers/vault/import',
    ah(async (req) => {
      noDevice(req);
      return vault.importRun(user(req), req.body || {});
    }),
  );
  api.put(
    '/computers/vault/:id',
    ah(async (req) => {
      noDevice(req);
      return vault.update(user(req), entryOf(req), req.body || {});
    }),
  );
  api.delete(
    '/computers/vault/:id',
    ah(async (req) => {
      noDevice(req);
      vault.remove(user(req), entryOf(req));
      return { ok: true };
    }),
  );
  /** Withdraw "always allow for this bot on this site". */
  api.delete(
    '/computers/vault/:id/grants/:agentId',
    ah(async (req) => {
      noDevice(req);
      const r = entryOf(req);
      vault.revokeGrant(user(req), r, str(req.params.agentId, 64), req.query.origin ? str(req.query.origin, 300) : undefined);
      return vault.view(vault.row(r.id)!);
    }),
  );
}
