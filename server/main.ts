import { createApp } from './app.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.split('=').slice(1).join('=') : undefined;
}

const mode = (arg('mode') as 'desktop' | 'server') || (process.argv.includes('--local') ? 'desktop' : undefined);

let app: Awaited<ReturnType<typeof createApp>>;
try {
  app = await createApp({
    port: arg('port') ? Number(arg('port')) : undefined,
    host: arg('host'),
    dataDir: arg('data'),
    mode,
  });
} catch (e: any) {
  // The startup check refused an unsafe exposure (server/modules/network/exposure.ts): say why in plain words.
  if (e?.code === 'exposure_refused') {
    console.error(`\n  TeamBot start niet: dit zou onveilig zijn.\n\n  ${String(e.message).split('\n').join('\n  ')}\n`);
    process.exit(1);
  }
  throw e;
}

if (app.ctx.config.mode === 'desktop') {
  const token = app.ctx.auth.ensureLocalOwner();
  console.log(`\n  ${app.ctx.config.appName} draait lokaal.\n  Open: ${app.url}/#token=${token}\n`);
} else if (app.ctx.auth.userCount() === 0) {
  const how = process.env.TEAMBOT_SETUP_TOKEN ? 'via de eenmalige link met het setup-token' : 'op deze computer via die pagina, vanaf een ander apparaat alleen met de eenmalige link hierboven';
  console.log(`\n  ${app.ctx.config.appName} draait op ${app.url}\n  Maak het eigenaar-account aan ${how}.\n`);
} else {
  console.log(`\n  ${app.ctx.config.appName} draait op ${app.url}\n`);
}

// Never a silent end: what nobody caught goes to the log file (logs/server.log) as well as the console. A stray
// rejection of one module does not stop everyone's bots; after an uncaught exception the state is unknown, so stop.
process.on('unhandledRejection', (e) => app.ctx.log.error('[server] niet-afgehandelde fout', e));
process.on('uncaughtException', (e) => {
  app.ctx.log.error('[server] gestopt door een onverwachte fout', e);
  process.exit(1);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
