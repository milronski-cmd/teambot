// electron-builder afterPack hook: switch off the Electron features TeamBot does not use, by flipping the fuses in the
// packed executable with @electron/fuses (MIT). This runs after packing and before signing, which the fuses require.
// The asar integrity hash that EnableEmbeddedAsarIntegrityValidation checks is written by electron-builder itself
// (a resource in the .exe on Windows, Info.plist on macOS) before this hook runs.
import path from 'node:path';
import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';

/**
 * The fuse settings, also read by tests/electron-fuses.test.ts.
 *
 * RunAsNode stays ON: the MCP bridge that gives the CLI bots (Claude Code, Codex, OpenCode) their TeamBot tools is a
 * small script that the CLI starts as `TeamBot.exe <bridge.js>` with ELECTRON_RUN_AS_NODE=1
 * (server/modules/cli-agents/proc.ts `nodeRuntime`, bridge.ts `stdioServer`). Most users have no Node.js of their
 * own, so switching it off would take those tools away. NODE_OPTIONS is ignored, also in that mode. The inspect fuse
 * blocks --inspect for TeamBot itself; Electron does not apply it in RunAsNode mode (checked on a packed 45.2.3 build).
 */
export const FUSES = {
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};

/** Path of the packed executable, as electron-builder names it per platform. */
export function executablePath(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const ext = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' }[electronPlatformName] ?? '';
  const name = electronPlatformName === 'linux' ? packager.executableName || packager.appInfo.productFilename : packager.appInfo.productFilename;
  return path.join(appOutDir, `${name}${ext}`);
}

export default async function afterPack(context) {
  const exe = executablePath(context);
  // arch 3 = arm64 in electron-builder's Arch enum: an ad-hoc signed macOS arm64 app must be re-signed after a flip
  await flipFuses(exe, { version: FuseVersion.V1, resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && context.arch === 3, ...FUSES });
  const wire = await getCurrentFuseWire(exe);
  const wrong = Object.entries(FUSES).filter(([k, v]) => wire[k] !== (v ? FuseState.ENABLE : FuseState.DISABLE));
  if (wrong.length) throw new Error(`Electron fuses not set in ${exe}: ${wrong.map(([k]) => FuseV1Options[k]).join(', ')}`);
  console.log(`  • electron fuses set in ${path.basename(exe)}: ${Object.entries(FUSES).map(([k, v]) => `${FuseV1Options[k]}=${v ? 'on' : 'off'}`).join(', ')}`);
}
