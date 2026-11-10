import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Agent, Approval, Message, ToolCall } from '../lib/types';

/**
 * UI contract for feature modules. Each module lives in ui/src/modules/<id>/index.tsx
 * and default-exports a UIModule. The app shell renders these extension points.
 */
export interface UIModule {
  id: string;
  label: string;

  /** Pages under #/m/<module id>/<path>. `path: ''` is the module's main page. */
  pages?: {
    path: string;
    title: string;
    icon?: LucideIcon;
    /**
     * No longer read: the sidebar is fixed (shell/nav.tsx). A page gets its place under Instellingen via
     * SETTINGS_GROUPS in lib/palette.ts. Kept so existing modules still compile.
     */
    nav?: boolean;
    /** Render without the app chrome (sidebar, tab bar), e.g. for a small desktop window. */
    bare?: boolean;
    component: React.ComponentType<{ params: string[] }>;
  }[];

  /** Extra sections in the bot editor (#/agents/<id>/edit). Call onChange to patch the agent (saved by the editor). */
  agentSections?: {
    id: string;
    title: string;
    component: React.ComponentType<{ agent: Agent; onChange(patch: Partial<Agent>): void }>;
  }[];

  /** Buttons rendered in the chat composer (e.g. push-to-talk). */
  composerActions?: React.ComponentType<{
    threadId: string;
    agentId: string | null;
    insertText(text: string): void;
    send(text: string, opts?: { voice?: boolean; attachments?: string[] }): Promise<void>;
  }>[];

  /** Extra actions in the chat header (e.g. start a live voice call). */
  chatHeaderActions?: React.ComponentType<{ threadId: string; agentId: string | null }>[];

  /**
   * Panels docked next to a chat (desktop) or shown as a full-screen sheet (phone), e.g. the bot's browser. Each one
   * decides itself whether it is open and renders null otherwise.
   */
  chatDocks?: React.ComponentType<{ threadId: string; agentId: string | null }>[];

  /** Custom card for a pending approval/question of one of the module's tools (by tool name); replaces the default card. */
  approvalRenderers?: Record<string, React.ComponentType<{ a: Approval; showThreadLink?: boolean }>>;

  /** Tabs in the right-hand inspector next to a chat. */
  inspectorTabs?: {
    id: string;
    title: string;
    component: React.ComponentType<{ threadId: string; agentId: string | null }>;
  }[];

  /** Tabs on the Settings page (#/settings/<id>). */
  settingsTabs?: { id: string; title: string; adminOnly?: boolean; component: React.ComponentType }[];

  /** Custom renderer for a tool call card, by exact tool name or prefix ending in '*'. Return null to use the default. */
  toolRenderers?: Record<string, React.ComponentType<{ call: ToolCall; message: Message }>>;

  /**
   * A section under "Wacht op jou" (e.g. decisions from the team database). `useCount` is a hook that returns how many
   * items wait for the owner; it is added to the inbox badge in the sidebar, the phone tab bar and the window title.
   */
  inbox?: { useCount?: () => number; component: React.ComponentType };

  /**
   * Card for an event in the transcript (role 'event'), by `message.parts.kind` (e.g. a hire proposal in a group with
   * approve/decline buttons). Replaces the default one-line event pill.
   */
  eventRenderers?: Record<string, React.ComponentType<{ message: Message }>>;

  /** Content shown under a message (e.g. play-audio button). */
  messageExtras?: React.ComponentType<{ message: Message }>[];

  /** Called once after login (subscribe to events, register service worker, ...). */
  init?(): void | (() => void);
}
