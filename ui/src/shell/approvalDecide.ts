import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { toastError } from '../components/ui';

/**
 * Answer an approval from a card of its own (a vault login, publishing a website, a workflow's "Jouw akkoord"): send
 * the decision, take the card away, show an error as a toast. `busy` names the button that is working (`key`, by
 * default the decision).
 */
export function useDecide(a: { id: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'deny' | 'always', answer?: string, key: string = decision) => {
    setBusy(key);
    try {
      await api.post(`/approvals/${a.id}`, { decision, answer });
      useApp.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return { busy, decide };
}
