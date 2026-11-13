// The TeamBot server for the screen tests: every e2e script that runs TeamBot in its own process takes createApp
// from here, so they all share the same test settings.
//  - TEAMBOT_NO_AUTO_DOWNLOAD: a test server never fetches the search model (±124 MB) by itself two minutes after
//    start (docs/DEVELOPING.md). A script that checks that download row starts its server with the variable set to 0.
process.env.TEAMBOT_NO_AUTO_DOWNLOAD ??= '1';
export const { createApp } = await import('../../server/app.ts');
