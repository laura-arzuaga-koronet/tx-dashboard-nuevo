/**
 * Definitions & Matrix.
 *
 * The matrix crosses Est GMV band × product tier over the wholesaler portfolio
 * and shows, per cell, how many accounts there are and how much of their flow
 * we actually capture. Clicking a cell drills into the table with those filters
 * applied — the point of the view is to go from "where is the opportunity" to
 * "which accounts", without retyping filters.
 *
 * Annualization comes from the selected period (12 / months), not a constant:
 * the legacy hardcoded 7 months and silently understated every cell the moment
 * the cubes gained an eighth.
 */
import type { AccountEvidence } from '../../../data/adapter/types';
import type { Period } from '../../../domain/period';
import { fmtMoney, fmtPct } from '../../../domain/format';
import { GMV_BANDS, getGmvBand } from '../../../domain/metrics';
import { isClientWholesaler } from '../../../data/adapter';
import { UNIVERSE_TAB } from '../../../domain/filters';
import type { FiltersAction } from '../../../state/filtersReducer';
import styles from './DefinitionsMatrix.module.css';

const PRODUCT_TIERS = ['Core+', 'eSuite', 'Procurement', 'K2K'] as const;

interface Cell {
  n: number;
  estFlow: number;
  koronet: number;
  online: number;
}

const emptyCell = (): Cell => ({ n: 0, estFlow: 0, koronet: 0, online: 0 });

function buildMatrix(all: readonly AccountEvidence[], period: Period) {
  // 12 / months of the selected period — the same factor the adapter uses.
  const annualize = period.months > 0 ? 12 / period.months : 1;

  const cells: Record<string, Record<string, Cell>> = {};
  for (const b of GMV_BANDS) {
    cells[b.label] = {};
    for (const t of PRODUCT_TIERS) cells[b.label][t] = emptyCell();
  }

  for (const ev of all) {
    if (!isClientWholesaler(ev)) continue;
    const tier = ev.identity?.product_tier ?? '';
    if (!PRODUCT_TIERS.includes(tier as (typeof PRODUCT_TIERS)[number])) continue;
    const band = getGmvBand(ev);
    if (!band) continue;

    const p = ev.potential;
    const c = cells[band][tier];
    c.n++;
    const estSell = p?.gmv_reference?.value ?? 0;
    const estBuy = p?.buy_gmv_estimated?.value ?? 0;
    c.estFlow += estSell + estBuy;

    const sell = (p?.koronet_sell_period?.value ?? 0) * annualize;
    const buy = (p?.koronet_buy_period?.value ?? 0) * annualize;
    c.koronet += sell + buy;
    c.online += (sell * (p?.sell_online_pct?.value ?? 0)) / 100
      + (buy * (p?.buy_online_pct?.value ?? 0)) / 100;
  }
  return cells;
}

/** Penetration capped at 100: the estimate can be lower than what we measure. */
function pen(c: Cell): number | null {
  if (!c.n || c.estFlow <= 0) return null;
  return Math.min((c.koronet / c.estFlow) * 100, 100);
}

function onlinePct(c: Cell): number | null {
  if (!c.koronet) return null;
  return Math.min((c.online / c.koronet) * 100, 100);
}

function toneFor(v: number | null): string {
  if (v == null) return '';
  if (v >= 60) return styles.green;
  if (v >= 25) return styles.amber;
  return styles.red;
}

interface Props {
  all: readonly AccountEvidence[];
  period: Period;
  dispatch: (a: FiltersAction) => void;
  onClose: () => void;
}

export function DefinitionsMatrix({ all, period, dispatch, onClose }: Props) {
  const cells = buildMatrix(all, period);

  /* La matriz cuenta sobre el universo completo, que ya codifica la
     pertenencia: dejar puesto el filtro de clase haría que la celda diga 6 y la
     tabla muestre 5. Lo que hacés clic tiene que ser lo que ves. */
  const drill = (tier: string, band: string) => {
    dispatch({
      type: 'setMany',
      values: { businessType: UNIVERSE_TAB, productTier: tier, gmvBand: band, accountClass: '', segment: '', search: '' },
    });
    onClose();
  };

  const totals: Record<string, Cell> = {};
  for (const t of PRODUCT_TIERS) totals[t] = emptyCell();
  const grand = emptyCell();

  return (
    <div className={styles.wrap}>
      <h2 className={styles.h2}>Matriz Est GMV × Product Tier</h2>
      <p className={styles.intro}>
        Sobre el portafolio de wholesalers. La penetración es lo que movemos anualizado sobre el flujo
        estimado (sell + buy) de esas cuentas; el online % es cuánto de lo que movemos pasa por canales
        digitales. Hacé clic en una celda para ver esas cuentas en la tabla.
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th>Est GMV</th>
              {PRODUCT_TIERS.map((t) => <th key={t}>{t}</th>)}
              <th className={styles.totalCol}>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {GMV_BANDS.map((b) => {
              const rowTotal = emptyCell();
              const row = PRODUCT_TIERS.map((t) => {
                const c = cells[b.label][t];
                rowTotal.n += c.n; rowTotal.estFlow += c.estFlow;
                rowTotal.koronet += c.koronet; rowTotal.online += c.online;
                totals[t].n += c.n; totals[t].estFlow += c.estFlow;
                totals[t].koronet += c.koronet; totals[t].online += c.online;
                return { tier: t, c };
              });
              grand.n += rowTotal.n; grand.estFlow += rowTotal.estFlow;
              grand.koronet += rowTotal.koronet; grand.online += rowTotal.online;

              return (
                <tr key={b.label}>
                  <th scope="row">{b.label}</th>
                  {row.map(({ tier, c }) => {
                    const p = pen(c);
                    return (
                      <td key={tier}>
                        {c.n === 0 ? <span className={styles.emptyCell}>—</span> : (
                          <button
                            type="button"
                            className={styles.cell}
                            onClick={() => drill(tier, b.label)}
                            title={`Ver las ${c.n} cuentas ${tier} en ${b.label}`}
                          >
                            <span className={styles.cellN}>{c.n}</span>
                            <span className={`${styles.cellPen} ${toneFor(p)}`}>{fmtPct(p)} pen.</span>
                            <span className={styles.cellOnline}>{fmtPct(onlinePct(c))} online</span>
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className={styles.totalCol}>
                    <span className={styles.cellN}>{rowTotal.n}</span>
                    <span className={`${styles.cellPen} ${toneFor(pen(rowTotal))}`}>{fmtPct(pen(rowTotal))}</span>
                  </td>
                </tr>
              );
            })}
            <tr className={styles.totalRow}>
              <th scope="row">TOTAL</th>
              {PRODUCT_TIERS.map((t) => (
                <td key={t}>
                  <span className={styles.cellN}>{totals[t].n}</span>
                  <span className={`${styles.cellPen} ${toneFor(pen(totals[t]))}`}>{fmtPct(pen(totals[t]))}</span>
                </td>
              ))}
              <td className={styles.totalCol}>
                <span className={styles.cellN}>{grand.n}</span>
                <span className={`${styles.cellPen} ${toneFor(pen(grand))}`}>{fmtPct(pen(grand))}</span>
                <span className={styles.cellOnline}>{fmtMoney(grand.estFlow, true)} de flujo</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className={styles.h2}>Definiciones y metodología</h2>

      <h3 className={styles.h3}>Fees y take rate</h3>
      <DefTable rows={[
        ['Direct Fees', 'Fees cobrados del lado de venta, del cubo TRANSACTION_FEES (billed, ks_flag=TRUE, mes por transaction_date).', 'observed'],
        ['Indirect Fees', 'Lo que pagan los proveedores de esta cuenta cuando ella compra por canales con fee (eCommerce/K2K/API; Offline excluido). El comprador se identifica vía K2K_CONNECTIONS —un join determinístico por id, no por nombre— y se aplica la tasa REAL de cada vendedor: fees que Koronet le facturó dividido las ventas que le medimos en ese canal. La mediana de esas tasas es 1,495%, pero API cae a ~0% y ahí el 1,5% plano sobreestimaba.', 'model'],
        ['Take Rate', '(Direct + Indirect) / (Est Buy + Est Sell). Antes era fees / koronet_sell, que medía ejecución sobre el volumen que ya movemos y estaba acotado por la propia tasa de fee. El denominador ahora es todo el flujo direccionable, así que el número se lee mucho más bajo: eso es el punto, no una regresión. Requiere Est Buy + Est Sell > $10K.', 'model'],
      ]} />

      <h3 className={styles.h3}>Penetración y online</h3>
      <DefTable rows={[
        ['Sell Penetration', 'Koronet sell anualizado / Est GMV. Cuando el Est GMV es Medido o Piso de red, la penetración es tautológica (~100%) y se marca como tal.', 'model'],
        ['Buy Penetration', 'Koronet buy anualizado / Est Buy GMV (Est GMV × 0,45, ratio de Christine).', 'model'],
        ['Online %', 'Online anualizado / Est GMV. Online = eCommerce + K2K + API (Regla 6): el cubo cambió de etiquetas a mitad de serie y los meses previos a ago-2025 usan los nombres por canal.', 'model'],
        ['Piso de red', 'Si el Koronet anualizado supera el Estimado, el estimado estaba mal: se reemplaza por el medido. Evita penetraciones por encima de 100%.', 'observed'],
      ]} />

      <h3 className={styles.h3}>Períodos y tendencia</h3>
      <DefTable rows={[
        ['Períodos', `Cuatro rangos explícitos anclados en el último mes cerrado del cubo de sell (hoy ${period.to}): YTD, 1er semestre, todo el año anterior y últimos 12 meses. Todas las métricas se calculan estrictamente dentro del rango.`, 'observed'],
        ['Tendencia', 'Cada métrica se recalcula sobre los mismos meses corridos 12 atrás, con la misma fórmula y el mismo denominador. Los montos van en %, los porcentajes en puntos porcentuales. Se suprime cuando el cubo no cubre la ventana anterior completa: un baseline parcial inventaría crecimiento.', 'observed'],
        ['Est GMV / Est Buy', 'No llevan tendencia: son una cifra anual única sin serie temporal detrás, así que cualquier delta reflejaría que se revisó el estimado, no que la cuenta cambió.', 'gap'],
      ]} />

      <h3 className={styles.h3}>Universo y calidad de datos</h3>
      <DefTable rows={[
        ['Universo WH', 'Conjunto explícito de sfdc_id: el filtro canónico (Client + Wholesaler + product_tier) unido a la hoja curada de Christine/Facundo. Es un conjunto y no una regla porque la pertenencia involucra criterio humano que ningún combinado de campos codifica.', 'observed'],
        ['618 · fuera de portafolio', 'Cuentas que solo la investigación externa del universo 618 identifica como wholesalers. Se registran para revisión pero no entran al portafolio ni a sus KPI, y no se les cambia el business_type en Salesforce: el 618 define wholesaler como "vende al por mayor al trade", que en floral incluye legítimamente a los importadores.', 'proxy'],
        ['Auto-ventas', 'Filas de venta cuyo cliente es la propia empresa: no son ventas, son sus compras por canales Koronet espejadas en la tabla de ventas. Se separan en self_sale_gmv y quedan fuera del Koronet Sell.', 'observed'],
        ['Motivo de celda vacía', '"$0" y "sin dato" se leen igual pero son decisiones distintas. Gris = el valor es correctamente cero (no vende online, no es comprador K2K). Ámbar con ⚠ = no lo sabemos.', 'observed'],
      ]} />
    </div>
  );
}

function DefTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.defs}>
        <thead>
          <tr><th>Métrica</th><th>Cómo se calcula</th><th>Evidencia</th></tr>
        </thead>
        <tbody>
          {rows.map(([name, how, state]) => (
            <tr key={name}>
              <td className={styles.defName}>{name}</td>
              <td>{how}</td>
              <td><span className={`ev-state ${state}`}>{state}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
