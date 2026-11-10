import type { UIModule } from './types';
import cliAgents from './cli-agents/index';
import memory from './memory/index';
import skills from './skills/index';
import mcp from './mcp/index';
import routines from './routines/index';
import rooms from './rooms/index';
import teams from './teams/index';
import voice from './voice/index';
import channels from './channels/index';
import browser from './browser/index';
import mobile from './mobile/index';
import folders from './folders/index';
import openbotImport from './openbot-import/index';
import usage from './usage/index';
import teamdata from './teamdata/index';
import quality from './quality/index';
import notifications from './notifications/index';
import sites from './sites/index';
import network from './network/index';
import seen from './seen/index';
import backups from './backups/index';
import freeModels from './free-models/index';
import engineChain from './engine-chain/index';
import specialists from './specialists/index';
import scriptKeys from './script-keys/index';
import remoteDesktop from './remote-desktop/index';
import health from './health/index';
import chatFolders from './chat-folders/index';
import workflows from './workflows/index';
import images from './images/index';
import websearch from './websearch/index';

export const uiModules: UIModule[] = [rooms, teams, memory, skills, mcp, routines, channels, voice, browser, cliAgents, mobile, folders, teamdata, openbotImport, usage, notifications, sites, network, seen, freeModels, engineChain, quality, specialists, scriptKeys, health, remoteDesktop, chatFolders, websearch, backups, workflows, images];

/** Items modules add to "Wacht op jou" (on top of approvals). The module list is fixed, so the hook order is stable. */
export function useInboxExtraCount(): number {
  let n = 0;
  for (const m of uiModules) if (m.inbox?.useCount) n += m.inbox.useCount();
  return n;
}

export function moduleById(id: string) {
  return uiModules.find((m) => m.id === id);
}
