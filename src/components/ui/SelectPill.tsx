import type { SelectHTMLAttributes } from 'react';
import styles from './SelectPill.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectPillProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
}

/** Compact pill-style <select> used across the top bar. */
export function SelectPill({ value, options, onChange, className, ...rest }: SelectPillProps) {
  return (
    <select
      className={[styles.select, className].filter(Boolean).join(' ')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
