/**
 * Card 6 · DATA COVERAGE — how many of the expected sources were found for this
 * account, and as of when. It is the card that tells the reader how much to
 * trust the other five.
 *
 * Omitted from the legacy card: nothing. The legacy version returned an empty
 * string when freshness was missing; here that degrades to a "no data" card so
 * the panel keeps its six slots.
 */
import type { AccountEvidence } from '../../../data/adapter/types';
import { CardFocus, CardGap, CardRow, CardTable, EvidenceCard } from '../EvidenceCard';

const GOOD_COVERAGE = 70;
const WEAK_COVERAGE = 40;

export function FreshnessCard({ ev }: { ev: AccountEvidence }) {
  const f = ev.freshness;
  if (!f) {
    return (
      <EvidenceCard label="Card 6 · DATA COVERAGE" headline="No coverage data" defaultOpen={false}>
        <CardGap>Could not assess which sources have a row for this account.</CardGap>
      </EvidenceCard>
    );
  }

  const pct = f.coverage_pct;
  const tone = pct >= GOOD_COVERAGE ? 'green' : pct >= WEAK_COVERAGE ? 'amber' : 'red';
  const missing = f.sources.filter((s) => !s.found).map((s) => s.source);

  return (
    <EvidenceCard
      label="Card 6 · DATA COVERAGE"
      headline={`${f.sources_used}/${f.sources_total} fuentes encontradas (${pct}% de cobertura)`}
      defaultOpen={false}
    >
      <CardFocus>
        <strong>How to read the other cards:</strong>{' '}
        {pct >= GOOD_COVERAGE
          ? 'most sources responded, so the figures above are measured, not estimated.'
          : pct >= WEAK_COVERAGE
            ? 'several sources are missing: where a card shows a gap, it is because there is no row, not because the value is zero.'
            : 'very few sources responded for this account; treat the figures above as indicative.'}
      </CardFocus>

      <CardRow
        label="Coverage"
        value={`${f.sources_used} / ${f.sources_total} sources (${pct}%)`}
        tone={tone}
      />
      <CardRow label="As of" value={f.as_of} />
      {missing.length ? <CardRow label="No row" value={missing.join(', ')} tone="muted" /> : null}

      <CardTable
        head={['Source', 'Found', 'As of']}
        rows={f.sources.map((s) => [
          s.source,
          s.found ? <span className="ev-state observed">Yes</span> : <span className="ev-state gap">No</span>,
          s.as_of ?? '—',
        ])}
      />
    </EvidenceCard>
  );
}
