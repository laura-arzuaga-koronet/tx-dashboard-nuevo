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
      <EvidenceCard label="Card 6 · DATA COVERAGE" headline="Sin datos de cobertura" defaultOpen={false}>
        <CardGap>No se pudo evaluar qué fuentes tienen fila para esta cuenta.</CardGap>
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
        <strong>Cómo leer las otras tarjetas:</strong>{' '}
        {pct >= GOOD_COVERAGE
          ? 'la mayoría de las fuentes respondió, así que los números de arriba están medidos, no estimados.'
          : pct >= WEAK_COVERAGE
            ? 'faltan varias fuentes: donde una tarjeta muestra un hueco, es porque no hay fila, no porque el valor sea cero.'
            : 'muy pocas fuentes respondieron para esta cuenta; tratá los números de arriba como indicativos.'}
      </CardFocus>

      <CardRow
        label="Cobertura"
        value={`${f.sources_used} / ${f.sources_total} fuentes (${pct}%)`}
        tone={tone}
      />
      <CardRow label="Fecha de corte" value={f.as_of} />
      {missing.length ? <CardRow label="Sin fila" value={missing.join(', ')} tone="muted" /> : null}

      <CardTable
        head={['Fuente', 'Encontrada', 'Fecha de corte']}
        rows={f.sources.map((s) => [
          s.source,
          s.found ? <span className="ev-state observed">Sí</span> : <span className="ev-state gap">No</span>,
          s.as_of ?? '—',
        ])}
      />
    </EvidenceCard>
  );
}
