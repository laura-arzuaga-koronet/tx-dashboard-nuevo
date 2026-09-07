import type { SparkBar } from '../../domain/metrics';
import styles from './Sparkline.module.css';

/** Four-bar mini trend; each bar colored by direction vs. the previous month. */
export function Sparkline({ bars, title }: { bars: SparkBar[]; title?: string }) {
  return (
    <div className={styles.spark} role="img" aria-label={title ?? 'Sell trend, last 4 months'} title={title}>
      {bars.map((b, i) => (
        <div key={i} className={`${styles.bar} ${styles[b.trend]}`} style={{ height: `${b.heightPct}%` }} />
      ))}
    </div>
  );
}
