/**
 * Semantic thresholds → tone + qualifier for each metric cell.
 * Centralized so the table, cards and matrix color the same number the same way.
 */
import type { AccountEvidence, GmvReference, Potential } from '../data/adapter/types';
import { evValue, fmtMoney } from './format';

export type Tone = 'green' | 'amber' | 'red' | 'muted' | 'muted-italic' | 'neutral';

export interface CellStyle {
  tone: Tone;
  qualifier: string;
}

const NEUTRAL: CellStyle = { tone: 'neutral', qualifier: '' };

/** Sell penetration: ≥40% green, 15–40% amber, <15% red. */
export function sellPenetrationStyle(p: Potential | null): CellStyle {
  if (!p) return NEUTRAL;
  if (p.sell_penetration.ev === 'tautological') return { tone: 'muted-italic', qualifier: 'Koronet = primary' };
  /* El estimado dice ser nuestra medición pero no coincide con el cubo: la
     penetración es real, no tautológica, y conviene que se vea de dónde viene. */
  if (p.gmv_reference?.unverified) return { tone: 'amber', qualifier: 'unverified estimate' };
  const v = evValue(p.sell_penetration);
  if (v == null) return NEUTRAL;
  if (v >= 40) return { tone: 'green', qualifier: 'high capture' };
  if (v >= 15) return { tone: 'amber', qualifier: '' };
  return { tone: 'red', qualifier: 'low capture' };
}

/** Buy penetration: ≥30% green, 10–30% amber, <10% red. */
export function buyPenetrationStyle(p: Potential | null): CellStyle {
  if (!p) return NEUTRAL;
  if (p.buy_penetration.ev === 'tautological') return { tone: 'muted-italic', qualifier: '' };
  const v = evValue(p.buy_penetration);
  if (v == null) return NEUTRAL;
  if (v >= 30) return { tone: 'green', qualifier: '' };
  if (v >= 10) return { tone: 'amber', qualifier: '' };
  return { tone: 'red', qualifier: '' };
}

export function isSoloDigital(ev: AccountEvidence): boolean {
  return ev.identity?.digital_pct_caveat === 'solo_digital_visible';
}

/** Sell online %: ≥30% green, 10–30% amber, >0 red, 0 muted. */
export function sellOnlineStyle(ev: AccountEvidence): CellStyle {
  if (isSoloDigital(ev)) return { tone: 'muted-italic', qualifier: 'digital only visible' };
  const v = ev.potential ? evValue(ev.potential.sell_online_pct) : null;
  if (v == null) return NEUTRAL;
  if (v >= 30) return { tone: 'green', qualifier: 'digital-first' };
  if (v >= 10) return { tone: 'amber', qualifier: 'digital' };
  if (v > 0) return { tone: 'red', qualifier: 'mostly offline' };
  return { tone: 'muted', qualifier: 'offline' };
}

/** Buy online %: ≥20% green, 5–20% amber, >0 red, 0 muted. */
export function buyOnlineStyle(ev: AccountEvidence): CellStyle {
  if (isSoloDigital(ev)) return { tone: 'muted-italic', qualifier: 'digital only visible' };
  const v = ev.potential ? evValue(ev.potential.buy_online_pct) : null;
  if (v == null) return NEUTRAL;
  if (v >= 20) return { tone: 'green', qualifier: 'digital-first' };
  if (v >= 5) return { tone: 'amber', qualifier: 'emerging' };
  if (v > 0) return { tone: 'red', qualifier: 'mostly offline' };
  return { tone: 'muted', qualifier: 'offline' };
}

/** Qualifier under Koronet Sell, derived from sell penetration. */
export function sellGrowthQualifier(p: Potential | null): string {
  if (!p || p.sell_penetration.ev === 'tautological') return '';
  const v = evValue(p.sell_penetration);
  if (v == null) return '';
  if (v < 15) return 'big opportunity';
  if (v < 40) return 'room to grow';
  return 'majority captured';
}

/** Take rate: ≥0.3% green, <0.1% red. */
export function takeRateTone(v: number | null): Tone {
  if (v == null) return 'neutral';
  if (v >= 0.3) return 'green';
  if (v < 0.1) return 'red';
  return 'neutral';
}

/** Fees: >$10K green, $0 muted. */
export function feesTone(v: number | null): Tone {
  if (v != null && v > 10_000) return 'green';
  if (v != null && v > 0) return 'neutral';
  return 'muted';
}

export function priorityTone(level: string | null): Tone {
  switch (level) {
    case 'P1': return 'red';
    case 'IMPL': return 'amber';
    case 'TA': return 'neutral'; // rendered blue by the component
    default: return 'muted';
  }
}

/** Est GMV cell — value line + qualifier line, following the legacy display rules. */
export interface GmvDisplay {
  value: string;
  qualifier: string;
  tone: Tone;
}

export function gmvDisplay(ev: AccountEvidence): GmvDisplay {
  const p = ev.potential;
  const ref: GmvReference | null = p?.gmv_reference ?? null;
  if (!ref || ref.value == null) return { value: '—', qualifier: '', tone: 'neutral' };

  const productTier = ev.identity?.product_tier ?? '';
  const ext = p?.gmv_external?.value ?? null;

  if (ref.confidence === 'Alta' && ref.source === 'Medido') {
    if (productTier === 'K2K' || productTier === 'Procurement') {
      const extStr = ext != null ? fmtMoney(ext, true) : null;
      return {
        value: extStr ?? fmtMoney(ref.value, true),
        qualifier: `${extStr ? 'External est. ' : ''}(Koronet: ${fmtMoney(ref.value, true)} via ${productTier})`,
        tone: 'neutral',
      };
    }
    return { value: `${fmtMoney(ref.value, true)} ✓ Measured`, qualifier: 'Observed', tone: 'neutral' };
  }
  if (ref.confidence === 'Baja') {
    return { value: `${fmtMoney(ref.value, true)} pace`, qualifier: 'Low confidence', tone: 'amber' };
  }
  if (ref.source === 'ORA') {
    return { value: `${fmtMoney(ref.value, true)} ORA`, qualifier: 'External (ORA)', tone: 'amber' };
  }
  return { value: fmtMoney(ref.value, true), qualifier: ref.source ?? '', tone: 'neutral' };
}
