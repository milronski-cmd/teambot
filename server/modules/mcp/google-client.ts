/**
 * TeamBot's own Google OAuth client ("Desktop app" type in Google Cloud). With it, every user connects Google with
 * one click on "Inloggen met Google"; without it, TeamBot leads the user through making an own client once
 * (ui/src/modules/mcp/Google.tsx, about five minutes).
 *
 * For a desktop app the client "secret" is not a secret (Google: installed applications cannot keep secrets); it
 * identifies the app, and the login itself is protected by PKCE and the redirect to this computer. It may be shipped.
 * The release build can also set TEAMBOT_GOOGLE_CLIENT_ID and TEAMBOT_GOOGLE_CLIENT_SECRET instead of filling this in.
 *
 * Still empty, because it has to be made on the name of the publisher of TeamBot, once:
 *  1. console.cloud.google.com: a project "TeamBot"; switch on the Search Console, Merchant, Google Ads, Analytics Data,
 *     Analytics Admin, Gmail, Calendar and Drive APIs (the link in the app's guide does all of them at once);
 *  2. Google Auth Platform: consent screen "TeamBot", audience "External", then "Publish app" (in "Testing" a login
 *     ends after 7 days). Unverified, Google shows "deze app is niet geverifieerd" and allows 100 users; for more, and
 *     to lose the warning, ask Google to verify the app (privacy page on an own domain; Gmail and Drive reading are
 *     "restricted" scopes and need a yearly security assessment);
 *  3. Clients › Create client › "Desktop app"; put the client ID and secret below.
 */
export const TEAMBOT_GOOGLE_CLIENT = { clientId: '', clientSecret: '' };
