/**
 * The tabs of the start screen without a session (Auth.tsx). On a server: log in, make an account (unless SSO is
 * required), pair a device. On the desktop app (one owner on this computer, no accounts, no sign-up) whoever arrives
 * here is a phone or another browser: pairing comes first and "Account maken" is not offered (it could never work).
 */
export type AuthTab = 'login' | 'signup' | 'pair';

export function authTabs(status: { mode: 'desktop' | 'server'; allowSignup?: boolean } | null, o: { ssoOnly?: boolean; chosen?: AuthTab | null } = {}): { tabs: AuthTab[]; shown: AuthTab } {
  const desktop = status?.mode === 'desktop';
  const tabs: AuthTab[] = desktop ? ['pair', 'login', ...(status?.allowSignup ? (['signup'] as const) : [])] : ['login', ...(o.ssoOnly ? [] : (['signup'] as const)), 'pair'];
  const shown = o.chosen && tabs.includes(o.chosen) ? o.chosen : tabs[0];
  return { tabs, shown };
}
