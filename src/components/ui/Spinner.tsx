import styles from './Spinner.module.css';

export function LoadingState({ text }: { text: string }) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <div className={styles.spinner} />
      <div className={styles.text}>{text}</div>
    </div>
  );
}

export function ErrorState({ text }: { text: string }) {
  return (
    <div className={styles.wrap} role="alert">
      <div className={`${styles.text} ${styles.error}`}>{text}</div>
    </div>
  );
}
