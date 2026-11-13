/** Team database: what importing a CSV or Excel file into a table gives (server/modules/teamdata/import-file.ts; the page shows it). Types only. */

export interface ImportResult {
  table: string;
  source: string;
  created: boolean;
  inserted: number;
  skipped: number;
  rows: number;
  columns: { name: string; label: string; type: string }[];
  sheet?: string;
  sheets?: string[];
  error?: string;
}
