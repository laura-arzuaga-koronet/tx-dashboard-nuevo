import styles from './Chip.module.css';

interface RemovableChipProps {
  label: string;
  onRemove: () => void;
}

/** Summarizes an active filter; click removes it. */
export function RemovableChip({ label, onRemove }: RemovableChipProps) {
  return (
    <button type="button" className={styles.chip} onClick={onRemove} title={`Remove filter: ${label}`}>
      {label} <span className={styles.x} aria-hidden>×</span>
    </button>
  );
}

export function ClearAllButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.clear} onClick={onClick}>clear all</button>
  );
}

interface ToggleChipProps {
  label: string;
  active: boolean;
  onToggle: () => void;
}

/** Multi-select quick filter (Priority / Impl). */
export function ToggleChip({ label, active, onToggle }: ToggleChipProps) {
  return (
    <button
      type="button"
      className={[styles.toggle, active ? styles.toggleActive : ''].join(' ')}
      onClick={onToggle}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
