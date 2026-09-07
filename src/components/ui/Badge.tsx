import styles from './Badge.module.css';

export type BadgeKind = 'businessType' | 'productTier' | 'segment' | 'sellChannel' | 'potentialTier';

export function Badge({ kind, children }: { kind: BadgeKind; children: string }) {
  return <span className={`${styles.badge} ${styles[kind]}`}>{children}</span>;
}
