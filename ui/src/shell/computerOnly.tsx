import { Monitor } from 'lucide-react';
import { cx } from '../components/ui';
import { useApp } from '../lib/store';

/**
 * Since 0.4.1 the owner's phone can do what the computer can, except a short list that hands out access or reveals
 * secrets if the phone is lost (server/modules/mobile/policy.ts COMPUTER_ONLY). On a phone those places say so calmly
 * with this note, instead of a spinner, a red error or a button that can only fail.
 */
export const useIsPhoneSession = () => useApp((s) => s.device);

export function ComputerOnly({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cx('flex items-start gap-2 text-sm text-muted', className)}>
      <Monitor className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
