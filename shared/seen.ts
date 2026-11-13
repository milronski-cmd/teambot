/**
 * "Wat heeft deze bot gezien en gedaan" (A-58) and the bot's own files in the side panel (A-35): the shape of the view
 * the server builds (server/modules/seen) and the page shows (ui/src/modules/seen). Types only.
 */

/** What a step touched, in data (for "Wat heeft deze bot gezien en gedaan" and the bot's files in the side panel). */
export interface StepFact {
  op: 'read' | 'write' | 'delete' | 'web' | 'search' | 'exec' | 'app';
  /** Full path, URL, command, search query or app name. */
  target: string;
}

export type SeenOp = StepFact['op'];
export interface SeenItem {
  op: SeenOp;
  /** Full path, URL, command, query or app name. */
  target: string;
  count: number;
  last: string;
  threadId: string;
  messageId: string;
}
export interface SeenFile extends SeenItem {
  name: string;
  /** Inside one of the bot's folders: which one (index as /folders/roots lists them) and the path in it. */
  root: number | null;
  rel: string | null;
  exists: boolean;
  size: number | null;
  mtime: string | null;
}
export interface SeenApproval {
  id: string;
  summary: string;
  status: string;
  risk: string;
  at: string;
  threadId: string | null;
}
export interface SeenView {
  agent: { id: string; name: string };
  threadId: string | null;
  days: number;
  read: SeenFile[];
  written: SeenFile[];
  deleted: SeenFile[];
  pages: SeenItem[];
  searches: SeenItem[];
  commands: SeenItem[];
  apps: SeenItem[];
  approvals: SeenApproval[];
  steps: number;
}
