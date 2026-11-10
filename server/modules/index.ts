import type { Module } from '../core/types.js';
import cliAgents from './cli-agents/index.js';
import memory from './memory/index.js';
import skills from './skills/index.js';
import mcp from './mcp/index.js';
import routines from './routines/index.js';
import teams from './teams/index.js';
import rooms from './rooms/index.js';
import voice from './voice/index.js';
import channels from './channels/index.js';
import browser from './browser/index.js';
import mobile from './mobile/index.js';
import sso from './sso/index.js';
import folders from './folders/index.js';
import openbotImport from './openbot-import/index.js';
import usage from './usage/index.js';
import teamdata from './teamdata/index.js';
import quality from './quality/index.js';
import notifications from './notifications/index.js';
import search from './search/index.js';
import network from './network/index.js';
import sites from './sites/index.js';
import seen from './seen/index.js';
import power from './power/index.js';
import history from './history/index.js';
import templates from './templates/index.js';
import backups from './backups/index.js';
import freeModels from './free-models/index.js';
import modelCatalog from './model-catalog/index.js';
import engineChain from './engine-chain/index.js';
import localModels from './local-models/index.js';
import specialists from './specialists/index.js';
import scriptKeys from './script-keys/index.js';
import remoteDesktop from './remote-desktop/index.js';
import health from './health/index.js';
import chatFolders from './chat-folders/index.js';
import workflows from './workflows/index.js';
import images from './images/index.js';
import botrules from './botrules/index.js';

/**
 * Feature modules, in load order. Each module owns its folder, migrations, routes and tools. `backups` stays last: after
 * a restore it rebuilds the search indexes once memory and history have re-applied what was forgotten or wiped.
 */
export const modules: Module[] = [network, cliAgents, memory, skills, mcp, routines, teams, rooms, voice, channels, browser, mobile, sso, folders, teamdata, openbotImport, usage, notifications, search, sites, seen, power, history, modelCatalog, freeModels, engineChain, localModels, quality, templates, specialists, scriptKeys, health, remoteDesktop, chatFolders, botrules, backups, workflows, images];
