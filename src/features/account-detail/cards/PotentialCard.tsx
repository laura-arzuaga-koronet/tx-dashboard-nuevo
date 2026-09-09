/**
 * Card 1 · POTENTIAL — the sell and buy sides side by side, and what the gap
 * between what the account moves and what it moves *through Koronet* is worth.
 *
 * This card is the exemplar the other five follow: read a slice of
 * AccountEvidence, state the finding in the headline, show the numbers with
 * their evidence state, and hand off to the next card.
 */
import type { AccountEvidence } from '../../../data/adapter/types';
import type { SfdcOppTotals } from '../../../data/sfdc/openOpportunities';
import { evValue, fmtMoney, fmtPct } from '../../../domain/format';
import { calcAtStake, detectOpportunityFlags } from '../../../domain/metrics';
import { CardFocus, CardGap, CardNext, CardTable, EvidenceCard } from '../EvidenceCard';

const K2K_RATE = 1.5;

function EvState({ state, label }: { state: string; label?: string }) {
  return <span className={`ev-state ${state}`}>{label ?? state}</span>;
}

export function PotentialCard({ ev, sfdcTotals }: { ev: AccountEvidence; sfdcTotals: SfdcOppTotals }) {
  const p = ev.potential;
  if (!p) {
    return (
      <EvidenceCard label="Card 1 · POTENTIAL" headline="Sin datos de potencial" defaultOpen={false}>
        <CardGap>Esta cuenta no tiene fila en accounts_v3 ni en los cubos.</CardGap>
      </EvidenceCard>
    );
  }

  const estSell = p.gmv_reference?.value ?? null;
  const estBuy = p.buy_gmv_estimated?.value ?? null;
  const kSell = evValue(p.koronet_sell_period);
  const kBuy = evValue(p.koronet_buy_period);
  const sellPen = evValue(p.sell_penetration);
  const buyPen = evValue(p.buy_penetration);
  const sellOnline = evValue(p.sell_online_pct);
  const buyOnline = evValue(p.buy_online_pct);
  const sellOffline = evValue(p.sell_offline_period);
  const buyOffline = evValue(p.buy_offline_period);
  const feesDirect = evValue(p.fees_direct);
  const feesIndirect = evValue(p.fees_indirect);
  const buyAttributed = evValue(p.buy_attributed);
  const indirectRate = evValue(p.indirect_rate);
  const takeRate = evValue(p.take_rate);
  const selfSale = evValue(p.self_sale_gmv);

  const sellTautological = p.sell_penetration?.ev === 'tautological';
  const penLabel = sellTautological
    ? 'Koronet es el canal principal'
    : sellPen != null ? `${fmtPct(sellPen)} del sell capturado` : '';
  const headline = [
    sellOffline ? `${fmtMoney(sellOffline, true)} offline sin fees.` : null,
    penLabel || null,
    sellOnline != null ? `${fmtPct(sellOnline)} online` : null,
  ].filter(Boolean).join(' ');

  const stake = calcAtStake(ev, sfdcTotals);
  const oppCount = Object.values(detectOpportunityFlags(ev)).filter(Boolean).length;

  const focus = stake?.source === 'sfdc'
    ? <><strong>{fmtMoney(stake.amount, true)} en oportunidades abiertas de SFDC</strong> — lo que se espera que esta cuenta pague.</>
    : sellOffline && buyOffline
      ? <>{fmtMoney(sellOffline, true)} de venta offline + {fmtMoney(buyOffline, true)} de compra offline → <strong>{fmtMoney(stake?.amount ?? null, true)}</strong> si el 10% pasa a online (10% de conversión × {fmtPct(K2K_RATE, 1)} de tasa K2K, ventana de 12 meses)</>
      : sellOffline
        ? <>{fmtMoney(sellOffline, true)} de venta offline → <strong>{fmtMoney(stake?.amount ?? null, true)}</strong> si el 10% pasa a online</>
        : <>Sin volumen offline medido en el período: no hay escenario de conversión que estimar.</>;

  return (
    <EvidenceCard label="Card 1 · POTENTIAL" headline={headline || 'Sin actividad en el período'}>
      <CardTable
        head={['', 'Estimado', 'Koronet', 'Penetración', 'Online %']}
        rows={[
          [
            <strong>SELL</strong>,
            <>{fmtMoney(estSell, true)}<br /><EvState state={p.gmv_reference?.confidence ?? 'gap'} label={p.gmv_reference?.source ?? 'gap'} />
              {p.gmv_reference?.annual != null && p.gmv_reference.annual !== estSell
                ? <div className="ev-note">{fmtMoney(p.gmv_reference.annual, true)} anual, prorrateado al período</div> : null}</>,
            fmtMoney(kSell, true),
            sellTautological ? '~100%' : fmtPct(sellPen),
            fmtPct(sellOnline),
          ],
          [
            <strong>BUY</strong>,
            <>{fmtMoney(estBuy, true)}<br /><EvState state={estBuy ? 'model' : 'gap'} label={estBuy ? 'Modelo — ratio 45%' : 'gap'} /></>,
            fmtMoney(kBuy, true),
            p.buy_penetration?.ev === 'tautological' ? '~100%' : fmtPct(buyPen),
            fmtPct(buyOnline),
          ],
        ]}
      />

      <CardTable
        head={['Fees', 'Monto', 'Base', 'Nota']}
        rows={[
          ['Direct', fmtMoney(feesDirect, true), fmtMoney(kSell, true) + ' de venta', 'Facturado, lado vendedor'],
          [
            'Indirect',
            fmtMoney(feesIndirect, true),
            buyAttributed ? fmtMoney(buyAttributed, true) + ' comprado' : '—',
            indirectRate != null
              ? `${fmtPct(indirectRate, 3)} — tasa real de sus proveedores`
              : 'No es comprador en ninguna conexión K2K',
          ],
          [
            <strong>Take rate</strong>,
            <strong>{fmtPct(takeRate, 2)}</strong>,
            fmtMoney((estSell ?? 0) + (estBuy ?? 0), true) + ' de flujo estimado del período',
            '(Direct + Indirect) / (Est Buy + Est Sell), ambos del período',
          ],
        ]}
      />

      {selfSale ? (
        <CardGap>
          {fmtMoney(selfSale, true)} de sus filas de venta tienen como cliente a la propia empresa:
          son compras suyas espejadas en la tabla de ventas, ya excluidas del Koronet Sell.
        </CardGap>
      ) : null}

      <CardFocus><strong>Foco:</strong> {focus}</CardFocus>

      <CardNext>
        → Continúa en <strong>OPPORTUNITIES</strong>
        {oppCount ? `: ${oppCount} intervención${oppCount !== 1 ? 'es' : ''} por ${fmtMoney(stake?.amount ?? null, true)}` : ''}
      </CardNext>
    </EvidenceCard>
  );
}
