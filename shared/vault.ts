/**
 * The login vault as the owner's page sees it (server/modules/browser/vault.ts and vault-import.ts; the page is
 * ui/src/modules/browser/Vault.tsx). Never the password or the 2FA secret.
 */

/** A login in the vault. The password and the 2FA secret never come back from the server. */
export interface VaultEntryView {
  id: string;
  label: string;
  origins: string[];
  username: string;
  has_password: boolean;
  has_totp: boolean;
  /** an http:// address other than this computer: the password would travel unencrypted */
  insecure: boolean;
  /** bots that may ask for this login ([] = all your bots) */
  agent_ids: string[];
  /** this login remembered for this bot on this site ("Inloggen en onthouden") */
  grants: { agent_id: string; origin: string; created_at: string }[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** A CSV export of a password manager may be this big at most. */
export const VAULT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** One row of a CSV import preview as the owner sees it: never the password or the 2FA key. */
export interface VaultImportRow {
  index: number;
  /** row number as a spreadsheet shows it (header = 1) */
  line: number;
  label: string;
  origins: string[];
  username: string;
  has_totp: boolean;
  insecure: boolean;
  /** new = can be imported · duplicate = already in the vault (or twice in the file) · skip = not a usable login */
  status: 'new' | 'duplicate' | 'skip';
  reason?: string;
  warning?: string;
}

export interface VaultImportPreview {
  handle: string;
  format: { id: string; label: string };
  expires_at: string;
  /** how many more logins fit in the vault */
  room: number;
  rows: VaultImportRow[];
}

export interface VaultImportResult {
  imported: number;
  skipped: { line: number; label: string; reason: string }[];
}
