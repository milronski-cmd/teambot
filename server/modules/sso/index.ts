import type { Module } from '../../core/types.js';
import { SCIM_PATH, ssoActive, ssoConfig } from './config.js';
import { OidcService } from './oidc.js';
import { requireSsoPolicy, ssoEmailPolicy, ssoRoutes } from './routes.js';
import { scimRouter } from './scim.js';
import { GROUP_MIGRATION, GroupMapper, groupAdminRoutes } from './groups.js';

/**
 * Team admin (TEAM-07): sign in with an OpenID Connect provider (Microsoft Entra ID, Google Workspace, any OIDC IdP)
 * and user + group provisioning via SCIM 2.0 (groups map to a role, rooms and a budget). Server mode only; see docs/modules/sso.md.
 */
const mod: Module = {
  id: 'sso',
  label: 'SSO & SCIM',
  migrations: [
    {
      id: 'sso-001',
      sql: `
CREATE TABLE sso_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sso_identities (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  email TEXT, created_at TEXT NOT NULL, last_login_at TEXT, UNIQUE (issuer, subject)
);
CREATE INDEX sso_identities_user ON sso_identities(user_id);
CREATE TABLE scim_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, external_id TEXT, user_name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX scim_users_external ON scim_users(external_id);
CREATE TABLE scim_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
`,
    },
    GROUP_MIGRATION,
  ],
  init(ctx) {
    const svc = new OidcService(ctx);
    ssoRoutes(ctx, svc);
    const groups = new GroupMapper(ctx);
    ctx.rootApi.use(SCIM_PATH, scimRouter(ctx, groups));
    groupAdminRoutes(ctx, groups);
    ctx.auth.passwordPolicies.push(requireSsoPolicy(ctx));
    ctx.auth.policies.push(ssoEmailPolicy(ctx));
    ctx.services.sso = {
      /** Is sign-in with SSO switched on (server mode, provider configured)? */
      active: () => ssoActive(ctx),
      /** Must non-owners sign in with SSO? */
      required: () => ssoActive(ctx) && ssoConfig(ctx).requireSso,
    };
  },
};

export default mod;
