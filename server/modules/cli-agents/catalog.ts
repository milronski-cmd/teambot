import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Catalogue of supported agent CLIs. Every flag and command here comes from the
 * CLI's official documentation, its own --help output or the ACP registry (checked 2026-11-07).
 * Entries marked `experimental` could not be fully verified (conflicting docs, third-party adapter).
 * Install and login commands are shown to the user to run themselves. Only on the owner's
 * explicit request (button + confirmation) TeamBot runs the official npm package install for
 * the CLIs that have one; it never performs a login on the user's behalf.
 */

export type Engine = 'claude' | 'codex' | 'acp' | 'unsupported';

export type AuthCheck =
  | { kind: 'claude' }
  | { kind: 'codex' }
  | { kind: 'cmd'; args: string[]; json?: boolean }
  /** files: a list, or a function when the location depends on the environment at check time (XDG_DATA_HOME). */
  | { kind: 'files'; files: string[] | (() => string[]); sole: boolean }
  | { kind: 'settings'; file: string };

export interface CliDef {
  id: string;
  label: string;
  engine: Engine;
  bins: string[];
  versionArgs: string[];
  /** ACP launch arguments; `acpFallback` is tried when `acpProbe` is missing from --help. */
  acpArgs?: string[];
  /** Older major versions that need other ACP arguments (OpenCode 1.x): below `below`, `acpArgs` are used instead. */
  legacy?: { below: number; acpArgs: string[] };
  /**
   * Extra environment for the ACP process. Used to make a CLI ask TeamBot before every edit/command/fetch, so the
   * bot's access mode (ask/auto/readonly) is decided by TeamBot's Broker and not by the CLI's own defaults.
   */
  acpEnv?: Record<string, string>;
  /** Env var (from acpEnv) with the CLI's inline JSON config; the bot's model is added there as `model`. */
  acpModelConfigEnv?: string;
  /** Official npm package, for the owner-confirmed one-click install (`npm install -g <pkg>`). */
  npmPackage?: string;
  /** Typical billing (label in the UI): subscription for own-login CLIs, free when free models are built in. */
  billing?: 'free' | 'subscription' | 'paid' | 'local';
  /** `<bin> <modelsArgs>` prints one "provider/model" per line (no prompt, no cost). */
  modelsArgs?: string[];
  acpProbe?: string;
  acpFallback?: string[];
  /** Flag to choose a model at launch (ACP agents). */
  modelFlag?: string;
  /** `other` = a winget command (Windows); `uv` = Python uv tool; `note` = a plain instruction, not a command. */
  install: { windows?: string; unix?: string; npm?: string; brew?: string; other?: string; uv?: string; note?: string };
  login: string;
  docsUrl: string;
  description: string;
  billingNote: string;
  authNote?: string;
  auth?: AuthCheck;
  models?: string[];
  /** Allowed extra flags → value validator (null = flag without value). */
  extraArgs?: Record<string, RegExp | null>;
  /** --help output must match (guards generic binary names like "agent"). */
  verify?: RegExp;
  /** Why this CLI cannot be used safely (shown in the UI). */
  unsupported?: string;
  custom?: boolean;
  /** Not fully verified against the vendor's docs (shown as "experimenteel"). */
  experimental?: boolean;
}

const home = os.homedir();

/** OpenCode's data folder (logins): $XDG_DATA_HOME/opencode, else ~/.local/share/opencode — read at check time. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
}
const MODEL = /^[\w.:/@+-]{1,120}$/;

export const CLI_DEFS: CliDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    engine: 'claude',
    bins: ['claude'],
    versionArgs: ['--version'],
    install: {
      windows: 'irm https://claude.ai/install.ps1 | iex',
      unix: 'curl -fsSL https://claude.ai/install.sh | bash',
      brew: 'brew install --cask claude-code',
      npm: 'npm install -g @anthropic-ai/claude-code',
      other: 'winget install Anthropic.ClaudeCode',
    },
    login: 'claude auth login',
    docsUrl: 'https://code.claude.com/docs/en/cli-reference',
    description: 'De officiële Claude Code-CLI van Anthropic, met je eigen login. Volledig ondersteund: streaming, sessies hervatten en goedkeuring per actie via TeamBot.',
    billingNote: 'Ingelogd met claude.ai: valt onder de limieten van je eigen Claude-abonnement (Pro/Max), geen extra kosten via TeamBot. Ingelogd met de Anthropic Console of een API-sleutel: betaal per gebruik op dat account.',
    authNote: 'Alleen voor jezelf: Anthropic staat toe dat je de ongewijzigde Claude Code met je eigen abonnement gebruikt; deel die login niet met anderen.',
    auth: { kind: 'claude' },
    billing: 'subscription',
    npmPackage: '@anthropic-ai/claude-code',
    models: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
    extraArgs: {
      '--fallback-model': MODEL,
      '--max-budget-usd': /^\d{1,4}(\.\d{1,2})?$/,
      '--agent': /^[\w.-]{1,60}$/,
      '--autocompact': /^(auto|\d{2,4}k|1M)$/i,
      '--exclude-dynamic-system-prompt-sections': null,
    },
  },
  {
    id: 'codex-cli',
    label: 'OpenAI Codex CLI',
    engine: 'codex',
    bins: ['codex'],
    versionArgs: ['--version'],
    install: {
      windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      npm: 'npm install -g @openai/codex',
      brew: 'brew install --cask codex',
    },
    login: 'codex login',
    docsUrl: 'https://learn.chatgpt.com/docs/non-interactive-mode',
    description: 'De officiële Codex-CLI van OpenAI met je eigen login. Alleen lezen en automatisch via "codex exec"; vraag-modus via de Codex app-server (goedkeuring per actie in TeamBot).',
    billingNote: 'Ingelogd met ChatGPT: valt onder je eigen ChatGPT-abonnement (Plus/Pro/Business). Ingelogd met een API-sleutel: standaard API-prijzen op je OpenAI-account.',
    auth: { kind: 'codex' },
    billing: 'subscription',
    npmPackage: '@openai/codex',
    models: ['default'],
    extraArgs: { '--oss': null, '--local-provider': /^(lmstudio|ollama)$/, '-p': /^[\w.-]{1,60}$/, '--profile': /^[\w.-]{1,60}$/ },
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    engine: 'acp',
    bins: ['gemini'],
    versionArgs: ['--version'],
    acpArgs: ['--acp'],
    acpProbe: '--acp',
    acpFallback: ['--experimental-acp'],
    modelFlag: '-m',
    install: { npm: 'npm install -g @google/gemini-cli', brew: 'brew install gemini-cli' },
    login: 'gemini  (kies daarna "Sign in with Google")',
    docsUrl: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md',
    description: 'Google Gemini CLI via het Agent Client Protocol (--acp).',
    billingNote: 'Sinds 18 juni 2026 niet meer voor gratis Google-accounts en Google AI Pro/Ultra (die gaan via Antigravity). Werkt met een Gemini Code Assist Standard/Enterprise-licentie, Vertex AI of je eigen betaalde Gemini API-sleutel.',
    authNote: 'TeamBot start de officiële gemini-binary via ACP met jouw bestaande login en leest of kopieert geen tokens.',
    auth: { kind: 'settings', file: path.join(home, '.gemini', 'settings.json') },
    extraArgs: { '--sandbox': null, '-s': null },
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    engine: 'acp',
    bins: ['qwen'],
    versionArgs: ['--version'],
    acpArgs: ['--acp'],
    acpProbe: '--acp',
    acpFallback: ['--experimental-acp'],
    modelFlag: '-m',
    install: {
      windows: 'irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex',
      unix: 'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash',
      npm: 'npm install -g @qwen-code/qwen-code@latest',
      brew: 'brew install qwen-code',
    },
    login: 'qwen  (daarna /auth)',
    docsUrl: 'https://github.com/QwenLM/qwen-code',
    description: 'Qwen Code van Alibaba via het Agent Client Protocol (--acp).',
    billingNote: 'De gratis Qwen OAuth-tier stopte op 15 april 2026. Nu via een Qwen Plus/Pro-abonnement, een Alibaba Coding Plan of je eigen API-sleutel, zoals ingesteld in de CLI.',
    auth: { kind: 'settings', file: path.join(home, '.qwen', 'settings.json') },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    engine: 'acp',
    bins: ['opencode'],
    versionArgs: ['--version'],
    // OpenCode 2.x (TeamBot's own copy, verified live with 2.2.6): `acp` runs its own private server
    // ("serve --stdio --port 0", not the shared background service) and answers a model call that fails for good
    // (the daily free limit: errorName "provider.free-limit") as an error of session/prompt within seconds. 2.x also
    // refuses the upper-case "--log-level ERROR" of 1.x and then only prints its help, so the plain command is used.
    acpArgs: ['acp'],
    // OpenCode 1.x (npm line): its log (errors only) on stderr, because a model call that fails for good is only logged
    // there while `session/prompt` waits forever (found live with 1.19.5). See fatalStderrError in acp.ts.
    legacy: { below: 2, acpArgs: ['acp', '--print-logs', '--log-level', 'ERROR'] },
    // OpenCode allows edits and commands by default (verified live with 1.19.5): without this a bot in "ask" mode
    // changed files without asking. Inline config has the highest precedence; the user's own model settings stay.
    // external_directory: OpenCode 2.x reads files outside its working folder without asking (verified live with
    // 2.2.5); asking routes every such path through TeamBot, which allows the bot's own folders and refuses the rest.
    acpEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' } }) },
    acpModelConfigEnv: 'OPENCODE_CONFIG_CONTENT',
    // --standalone (OpenCode 2.x): without it "models" starts or joins a shared managed service on a fixed port and
    // fails while another OpenCode (e.g. OpenBot's) holds that port. Older versions: cliModelList retries without it.
    modelsArgs: ['models', '--standalone'],
    billing: 'free',
    // TeamBot keeps its own copy (runtimes.ts, from the GitHub releases); npm only has the older 1.x line.
    npmPackage: 'opencode-ai',
    install: { unix: 'curl -fsSL https://opencode.ai/v2/install | bash', npm: 'npm i -g opencode-ai', windows: 'scoop install opencode  (of: choco install opencode)', brew: 'brew install anomalyco/tap/opencode-v2' },
    login: 'opencode auth login',
    docsUrl: 'https://opencode.ai/docs/acp/',
    description: 'OpenCode via het Agent Client Protocol (opencode acp). Heeft gratis modellen zonder account (OpenCode Zen, bijv. opencode/big-pickle) en werkt ook met lokale Ollama-modellen en de providers die je in OpenCode koppelde.',
    billingNote: 'Gratis met de ingebouwde gratis modellen (namen op "-free" en big-pickle) of lokale Ollama-modellen; andere modellen via je eigen sleutels of abonnement in OpenCode.',
    // v1 keeps logins in auth.json, v2 in its SQLite database (only checked for existence, never opened).
    // Under $XDG_DATA_HOME/opencode when that is set (as OpenCode itself does), else ~/.local/share/opencode.
    auth: { kind: 'files', files: () => [path.join(opencodeDataDir(), 'auth.json'), path.join(opencodeDataDir(), 'opencode.db')], sole: false },
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot CLI',
    engine: 'acp',
    bins: ['copilot'],
    versionArgs: ['--version'],
    acpArgs: ['--acp'],
    install: { windows: 'winget install GitHub.Copilot', brew: 'brew install --cask copilot-cli', npm: 'npm install -g @github/copilot', unix: 'curl -fsSL https://gh.io/copilot-install | bash' },
    login: 'copilot login',
    docsUrl: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    description: 'GitHub Copilot CLI via het Agent Client Protocol (copilot --acp).',
    billingNote: 'Valt onder je eigen Copilot-abonnement; sinds 1 juni 2026 in GitHub AI Credits (ook het Free-plan heeft een beperkt aantal).',
    authNote: 'Tokens uit omgevingsvariabelen (GH_TOKEN e.d.) geeft TeamBot niet door; log in met "copilot login".',
    auth: { kind: 'files', files: [path.join(home, '.copilot', 'config.json')], sole: false },
    extraArgs: { '--effort': /^(low|medium|high|xhigh)$/ },
  },
  {
    id: 'cursor-cli',
    label: 'Cursor CLI',
    engine: 'acp',
    bins: ['cursor-agent', 'agent'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    verify: /cursor/i,
    install: { unix: 'curl https://cursor.com/install -fsS | bash', windows: "irm 'https://cursor.com/install?win32=true' | iex" },
    login: 'agent login',
    docsUrl: 'https://cursor.com/docs/cli/acp',
    description: 'Cursor-agent via het Agent Client Protocol (agent acp).',
    billingNote: 'Valt onder je eigen Cursor-abonnement of Cursor API-sleutel.',
    auth: { kind: 'cmd', args: ['status', '--format', 'json'], json: true },
  },
  {
    id: 'kimi-code',
    label: 'Kimi Code CLI',
    engine: 'acp',
    bins: ['kimi'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    install: { unix: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash', windows: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex', brew: 'brew install kimi-code', npm: 'npm i -g @moonshot-ai/kimi-code' },
    login: 'kimi login',
    docsUrl: 'https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-acp.md',
    description: 'Kimi Code CLI van Moonshot via het Agent Client Protocol (kimi acp).',
    billingNote: 'Kimi Code-login (abonnement) of je eigen Kimi Platform API-sleutel.',
    auth: { kind: 'files', files: [path.join(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'credentials')], sole: true },
  },
  {
    id: 'hermes-agent',
    label: 'Hermes Agent',
    engine: 'acp',
    bins: ['hermes'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    install: { unix: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', windows: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)', brew: 'brew install hermes-agent' },
    login: 'hermes setup',
    docsUrl: 'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md',
    description: 'Hermes Agent van Nous Research via het Agent Client Protocol (hermes acp; vereist de ACP-extra, controleer met "hermes acp --check").',
    billingNote: 'Gebruikt de provider en sleutels die je in Hermes hebt ingesteld.',
    auth: { kind: 'files', files: [path.join(home, '.hermes', 'auth.json'), path.join(home, '.hermes', '.env')], sole: false },
  },
  {
    id: 'grok-build',
    label: 'Grok Build (xAI)',
    engine: 'acp',
    bins: ['grok'],
    versionArgs: ['version'],
    acpArgs: ['agent', 'stdio'],
    install: { unix: 'curl -fsSL https://x.ai/cli/install.sh | bash', windows: 'irm https://x.ai/cli/install.ps1 | iex', npm: 'npm install -g @xai-official/grok' },
    login: 'grok login  (of zet XAI_API_KEY)',
    docsUrl: 'https://docs.x.ai/build/overview',
    description: 'De officiële Grok Build-CLI van xAI via het Agent Client Protocol (grok agent stdio).',
    billingNote: 'Je eigen Grok-abonnement of xAI API-sleutel (per token), zoals ingesteld in de CLI. Let op: het npm-pakket @vibe-kit/grok-cli is niet van xAI.',
  },
  {
    id: 'cline-cli',
    label: 'Cline CLI',
    engine: 'acp',
    bins: ['cline'],
    versionArgs: ['--version'],
    acpArgs: ['--acp'],
    install: { npm: 'npm install -g cline' },
    login: 'cline auth',
    docsUrl: 'https://docs.cline.bot/usage/acp',
    description: 'Cline via het Agent Client Protocol (cline --acp); in ACP-modus keurt Cline zelf niets automatisch goed.',
    billingNote: 'Cline-tegoed, ClinePass, je eigen API-sleutel of ChatGPT-abonnement, zoals ingesteld in Cline.',
    auth: { kind: 'files', files: [path.join(home, '.cline', 'data', 'settings', 'providers.json')], sole: true },
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity CLI',
    engine: 'acp',
    bins: ['agy'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    install: { note: 'Installeer Google Antigravity via antigravity.google; de CLI "agy" komt mee.' },
    login: 'agy acp --login  (of log in via de Antigravity-app)',
    docsUrl: 'https://antigravity.google/docs',
    description: 'Google Antigravity via het Agent Client Protocol (agy acp): de opvolger van de Gemini CLI voor gratis Google-accounts en Google AI Pro/Ultra.',
    billingNote: 'Gratis tier met je Google-account (plus tegoed), of een Enterprise-abonnement; ook een eigen Gemini API-sleutel werkt.',
    billing: 'subscription',
    experimental: true,
  },
  {
    id: 'goose',
    label: 'Goose',
    engine: 'acp',
    bins: ['goose'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    // Goose's default mode ("auto") runs tools without asking; "approve" makes it ask TeamBot first.
    acpEnv: { GOOSE_MODE: 'approve' },
    install: {
      unix: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash',
      brew: 'brew install block-goose-cli',
      note: 'Windows: download download_cli.ps1 van github.com/aaif-goose/goose en voer het uit in PowerShell.',
    },
    login: 'goose configure',
    docsUrl: 'https://goose-docs.ai/docs',
    description: 'Goose (open source, oorspronkelijk van Block) via het Agent Client Protocol (goose acp). TeamBot start Goose in de modus "approve", zodat hij om toestemming vraagt.',
    billingNote: 'Goose zelf is gratis (Apache-2.0); je betaalt de provider die je in "goose configure" kiest, of gebruikt een lokaal model.',
  },
  {
    id: 'devin-cli',
    label: 'Devin CLI',
    engine: 'acp',
    bins: ['devin'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    install: { unix: 'curl -fsSL https://cli.devin.ai/install.sh | bash', windows: 'irm https://static.devin.ai/cli/setup.ps1 | iex', brew: 'brew install --cask devin-cli' },
    login: 'devin auth login',
    docsUrl: 'https://docs.devin.ai/cli',
    description: 'De officiële Devin CLI van Cognition via het Agent Client Protocol (devin acp).',
    billingNote: 'Devin-abonnement (Free met beperkingen, Pro, Max, Teams) of Enterprise-ACU’s.',
    billing: 'subscription',
  },
  {
    id: 'auggie',
    label: 'Augment Auggie',
    engine: 'acp',
    bins: ['auggie'],
    versionArgs: ['--version'],
    acpArgs: ['--acp'],
    acpEnv: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
    npmPackage: '@augmentcode/auggie',
    install: { npm: 'npm install -g @augmentcode/auggie', note: 'Op Windows alleen via WSL.' },
    login: 'auggie login',
    docsUrl: 'https://docs.augmentcode.com/cli/acp',
    description: 'Augment Code Auggie CLI via het Agent Client Protocol (auggie --acp).',
    billingNote: 'Augment-abonnement plus gebruik; geen gratis tier.',
    billing: 'subscription',
    modelFlag: '--model',
  },
  {
    id: 'factory-droid',
    label: 'Factory Droid',
    engine: 'acp',
    bins: ['droid'],
    versionArgs: ['--version'],
    acpArgs: ['exec', '--output-format', 'acp'],
    install: { unix: 'curl -fsSL https://app.factory.ai/cli | sh', windows: 'irm https://app.factory.ai/cli/windows | iex', brew: 'brew install --cask droid', npm: 'npm install -g droid' },
    login: 'droid  (log in bij de eerste start, of zet FACTORY_API_KEY)',
    docsUrl: 'https://docs.factory.ai/cli/droid-exec/overview',
    description: 'Factory Droid via het Agent Client Protocol (droid exec --output-format acp). Niet live getest: de ACP-registry noemt een andere uitvoermodus dan Factory zelf.',
    billingNote: 'Factory-abonnement (Pro, Plus, Max) of je eigen sleutels (BYOK); geen gratis tier.',
    billing: 'subscription',
    experimental: true,
  },
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    engine: 'acp',
    bins: ['vibe-acp'],
    versionArgs: ['--version'],
    acpArgs: [],
    install: { unix: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash', brew: 'brew install mistral-vibe', uv: 'uv tool install mistral-vibe' },
    login: 'vibe --setup',
    docsUrl: 'https://docs.mistral.ai/vibe',
    description: 'Mistral Vibe via zijn ACP-programma vibe-acp.',
    billingNote: 'Mistral-account (Free met beperkingen, Pro, Team) of je eigen Mistral API-sleutel.',
    billing: 'subscription',
    experimental: true,
  },
  {
    id: 'junie-cli',
    label: 'JetBrains Junie',
    engine: 'acp',
    bins: ['junie'],
    versionArgs: ['--version'],
    acpArgs: ['--acp=true'],
    install: {
      unix: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
      windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm 'https://junie.jetbrains.com/install.ps1')"`,
      brew: 'brew tap jetbrains-junie/junie && brew install junie',
      npm: 'npm install -g @jetbrains/junie',
    },
    login: 'junie  (log in met je JetBrains-account bij de eerste start)',
    docsUrl: 'https://junie.jetbrains.com/docs/junie-cli-acp.html',
    description: 'JetBrains Junie CLI via het Agent Client Protocol (--acp=true).',
    billingNote: 'JetBrains AI-tegoed (ook een klein gratis tegoed per maand), of je eigen sleutels.',
    billing: 'subscription',
    modelFlag: '--model',
  },
  {
    id: 'kiro-cli',
    label: 'Kiro CLI (AWS)',
    engine: 'acp',
    bins: ['kiro-cli'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    install: { unix: 'curl -fsSL https://cli.kiro.dev/install | bash', windows: 'irm https://cli.kiro.dev/install.ps1 | iex', brew: 'brew install --cask kiro-cli' },
    login: 'kiro-cli login',
    docsUrl: 'https://kiro.dev/docs/cli/acp/',
    description: 'Kiro CLI van AWS (opvolger van Amazon Q CLI) via het Agent Client Protocol (kiro-cli acp).',
    billingNote: 'Kiro-account: gratis 50 credits per maand, daarna Pro t/m Power.',
    billing: 'subscription',
  },
  {
    id: 'kilo-code',
    label: 'Kilo Code CLI',
    engine: 'acp',
    bins: ['kilo', 'kilocode'],
    versionArgs: ['--version'],
    acpArgs: ['acp'],
    npmPackage: '@kilocode/cli',
    install: { npm: 'npm install -g @kilocode/cli', unix: 'curl -fsSL https://kilo.ai/cli/install | bash', brew: 'brew install Kilo-Org/tap/kilo' },
    login: 'kilo auth login',
    docsUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
    description: 'Kilo Code CLI (een OpenCode-afsplitsing) via het Agent Client Protocol (kilo acp). Heeft gratis ":free"-modellen met limieten.',
    billingNote: 'Gratis ":free"-modellen (met limieten), Kilo Gateway-tegoed, Kilo Pass of je eigen sleutels.',
    billing: 'free',
  },
  {
    id: 'amp-acp',
    label: 'Amp (via amp-acp)',
    engine: 'acp',
    bins: ['amp-acp'],
    versionArgs: ['--version'],
    acpArgs: [],
    install: { npm: 'npm install -g @ampcode/cli amp-acp' },
    login: 'amp login',
    docsUrl: 'https://ampcode.com/docs/cli',
    description: 'Sourcegraph Amp heeft geen eigen ACP; dit gebruikt de community-adapter amp-acp, die je bestaande "amp login" hergebruikt.',
    billingNote: 'Amp Hobby (gratis, met je eigen abonnement of sleutels), pay-as-you-go-tegoed of Individual.',
    billing: 'subscription',
    experimental: true,
  },
  {
    id: 'pi-agent',
    label: 'Pi coding agent',
    engine: 'unsupported',
    bins: ['pi'],
    versionArgs: ['--version'],
    install: { unix: 'curl -fsSL https://pi.dev/install.sh | sh', windows: 'powershell -c "irm https://pi.dev/install.ps1 | iex"', npm: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' },
    login: 'pi auth login <provider>',
    docsUrl: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent',
    description: 'Pi heeft geen eigen ACP en vraagt volgens de eigen documentatie nooit toestemming voor tools; ook de community-adapter pi-acp vraagt niets voor tool-aanroepen (gecontroleerd 2026-11-07).',
    billingNote: 'Per provider: abonnement-login of API-sleutel.',
    unsupported: 'Niet ondersteund: Pi voert tools uit zonder toestemming te vragen, dus TeamBot kan de toegangsmodus van de bot niet afdwingen.',
  },
  {
    id: 'acp-custom',
    label: 'Eigen ACP-agent',
    engine: 'acp',
    bins: [],
    versionArgs: ['--version'],
    acpArgs: [],
    install: {},
    login: 'zie de documentatie van je agent',
    docsUrl: 'https://agentclientprotocol.com',
    description: 'Elke agent die het Agent Client Protocol over stdio spreekt (bijv. een eigen runner). Stel het programma en de argumenten in.',
    billingNote: 'Afhankelijk van je eigen agent.',
    custom: true,
  },
];

export const defById = (id: string) => CLI_DEFS.find((d) => d.id === id);

/** Validate extra CLI flags against the per-CLI allowlist. Throws with a clear message. */
export function checkExtraArgs(def: CliDef, list: string[]): string[] {
  const allowed = def.extraArgs || {};
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('-') && eq > 0 ? raw.slice(0, eq) : raw;
    if (!Object.hasOwn(allowed, flag)) throw new Error(`Extra argument niet toegestaan voor ${def.label}: ${flag}. Toegestaan: ${Object.keys(allowed).join(', ') || '(geen)'}`);
    const v = allowed[flag];
    if (v === null) {
      out.push(flag);
      continue;
    }
    const value = eq > 0 && raw.startsWith('-') ? raw.slice(eq + 1) : list[++i];
    if (value === undefined || !v.test(value)) throw new Error(`Ongeldige waarde voor ${flag} (${def.label})`);
    out.push(flag, value);
  }
  return out;
}

/** Validate a custom ACP command line: arguments are plain strings without control characters. */
export function checkCustomArgs(args: any): string[] {
  if (args === undefined || args === null || args === '') return [];
  const list = Array.isArray(args) ? args : String(args).split(/\s+/).filter(Boolean);
  if (list.length > 30) throw new Error('Maximaal 30 argumenten');
  return list.map((a) => {
    const s = String(a);
    if (s.length > 300 || /[\r\n\0]/.test(s)) throw new Error('Ongeldig argument');
    return s;
  });
}

/** Install commands to copy, and a plain instruction (`note: true`) that is read, not copied: shown as text so it is translated. */
export function installLines(def: CliDef): { label: string; cmd: string; note?: boolean }[] {
  const out: { label: string; cmd: string; note?: boolean }[] = [];
  const i = def.install;
  if (process.platform === 'win32') {
    if (i.windows) out.push({ label: 'Windows (PowerShell)', cmd: i.windows });
    if (i.other) out.push({ label: 'Windows (winget)', cmd: i.other });
  } else if (i.unix) out.push({ label: process.platform === 'darwin' ? 'macOS' : 'Linux', cmd: i.unix });
  if (i.brew && process.platform !== 'win32') out.push({ label: 'Homebrew', cmd: i.brew });
  if (i.npm) out.push({ label: 'npm (Node.js)', cmd: i.npm });
  if (i.uv) out.push({ label: 'uv (Python)', cmd: i.uv });
  if (process.platform === 'win32' && i.unix && !i.windows && !i.npm && !i.uv) out.push({ label: 'WSL / macOS / Linux', cmd: i.unix });
  if (i.note) out.push({ label: 'Let op', cmd: i.note, note: true });
  return out;
}

export function fileExists(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size > 0 : st.isDirectory() && fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}
