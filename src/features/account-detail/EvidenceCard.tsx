/**
 * Shell shared by the six evidence cards.
 *
 * Every card is a collapsible section with a label, a one-line headline that
 * states the finding in words, and a body. The legacy dashboard built these as
 * HTML strings; here each card is a component that reads its own slice of
 * AccountEvidence, so a missing slice degrades to a "no data" line instead of
 * blanking the panel.
 */
import { useState, type ReactNode } from 'react';
import styles from './EvidenceCard.module.css';

interface EvidenceCardProps {
  /** e.g. "Card 1 · POTENTIAL" */
  label: string;
  /** One line stating the finding, not the metric name. */
  headline: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Shown under the headline when the card needs a caveat. */
  subtitle?: ReactNode;
}

export function EvidenceCard({ label, headline, children, defaultOpen = true, subtitle }: EvidenceCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={styles.card}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.chevron} aria-hidden>{open ? '▾' : '▸'}</span>
        <span className={styles.label}>{label}</span>
      </button>
      <div className={styles.headline}>{headline}</div>
      {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
      {open ? <div className={styles.body}>{children}</div> : null}
    </section>
  );
}

/** A labelled section inside a card body. */
export function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{title}</div>
      {children}
    </div>
  );
}

/** label → value line. `note` is the small grey line underneath. */
export function CardRow({ label, value, note, tone }: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'green' | 'amber' | 'red' | 'muted';
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>
        <strong className={tone ? styles[tone] : undefined}>{value ?? '—'}</strong>
        {note ? <span className={styles.rowNote}>{note}</span> : null}
      </span>
    </div>
  );
}

/** Small table used by several cards. */
export function CardTable({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  if (!rows.length) return <div className={styles.gap}>Sin datos para este período.</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Shown when a card has no evidence at all — says which source is missing. */
export function CardGap({ children }: { children: ReactNode }) {
  return <div className={styles.gap}>{children}</div>;
}

/** The callout strip at the top of a card body. */
export function CardFocus({ children }: { children: ReactNode }) {
  return <div className={styles.focus}>{children}</div>;
}

/** "Continue to X" link at the bottom of a card. */
export function CardNext({ children }: { children: ReactNode }) {
  return <div className={styles.next}>{children}</div>;
}
