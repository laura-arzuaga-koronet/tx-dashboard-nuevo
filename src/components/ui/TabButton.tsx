import type { ReactNode } from 'react';
import styles from './TabButton.module.css';

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  count?: number | string | null;
  children: ReactNode;
  className?: string;
}

export function TabButton({ active, onClick, count, children, className }: TabButtonProps) {
  return (
    <button
      type="button"
      className={[styles.tab, active ? styles.active : '', className].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
      {count !== undefined && <span className={styles.count}>{count ?? '—'}</span>}
    </button>
  );
}

interface TabsNavProps {
  children: ReactNode;
  /** No bottom border — used when another nav follows immediately. */
  flush?: boolean;
  'aria-label'?: string;
}

export function TabsNav({ children, flush, ...aria }: TabsNavProps) {
  return (
    <div role="tablist" className={[styles.nav, flush ? styles.navFlush : ''].join(' ')} {...aria}>
      {children}
    </div>
  );
}

export function TabsSpacer() {
  return <span className={styles.spacer} />;
}
