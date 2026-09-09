/**
 * Definitions & Matrix.
 *
 * The matrix crosses Est GMV band × product tier over the wholesaler portfolio
 * and shows, per cell, how many accounts there are and how much of their flow
 * we actually capture. Clicking a cell drills into the table with those filters
 * applied — the point of the view is to go from "where is the opportunity" to
 * "which accounts", without retyping filters.
 *
 * Both sides of every cell are scoped to the selected period: the adapter
 * prorates Est GMV to it, and the Koronet figures are measured inside it.
 * Nothing is annualized here — the legacy hardcoded a 7-month factor and
 * silently understated every cell the moment the cubes gained an eighth.
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

function buildMatrix(all: readonly AccountEvidence[]) {
  /* No annualization here any more: the adapter now prorates Est GMV to the
     period, so both sides of the ratio already span the same months. */
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

    const sell = p?.koronet_sell_period?.value ?? 0;
    const buy = p?.koronet_buy_period?.value ?? 0;
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
  const cells = buildMatrix(all);

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
      <h2 className={styles.h2}>Est GMV × Product Tier matrix</h2>
      <p className={styles.intro}>
        Over the wholesaler portfolio. Penetration is what we move in the period over those accounts'
        estimated flow (sell + buy) prorated to that same period; online % is how much of what we move
        goes through digital channels. Click a cell to see those accounts in the table.
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th title="Band by annual Est GMV — does not change with the period">Est GMV (annual)</th>
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
                            title={`View the ${c.n} ${tier} accounts in ${b.label}`}
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
                <span className={styles.cellOnline}>{fmtMoney(grand.estFlow, true)} of flow</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 className={styles.h2}>Definitions and methodology</h2>

      <h3 className={styles.h3}>Fees and take rate</h3>
      <DefTable rows={[
        ['Direct Fees', 'Fees charged on the sell side, from the TRANSACTION_FEES cube (billed, ks_flag=TRUE, month by transaction_date).', 'observed'],
        ['Indirect Fees', 'What this account\u2019s suppliers pay when it buys through fee-carrying channels (eCommerce/K2K/API; Offline excluded). The buyer is identified via K2K_CONNECTIONS — a deterministic id join, not name matching — and each seller\u2019s REALISED rate is applied: fees Koronet billed them divided by the sales we measure for them on that channel. The median of those rates is 1.495%, but API drops to ~0%, where a flat 1.5% overstated it.', 'model'],
        ['Take Rate', '(Direct + Indirect) / (Est Buy + Est Sell). It used to be fees / koronet_sell, which measured execution over the volume we already move and was bounded by the fee rate itself. The denominator is now the whole addressable flow, so the number reads much lower: that is the point, not a regression. Both sides span the same months: fees billed in the period over the flow estimated for that period. Against the annual denominator, the YTD take rate came out 12/8 too low purely from the unit mismatch.', 'model'],
      ]} />

      <h3 className={styles.h3}>Penetration and online</h3>
      <DefTable rows={[
        ['Sell Penetration', 'Koronet sell in the period / Est GMV prorated to that same period. When Est GMV is Medido or Piso de red, penetration is tautological (~100%) and is flagged as such.', 'model'],
        ['Buy Penetration', 'Koronet buy in the period / Est Buy GMV prorated (Est GMV × 0.45, Christine\u2019s ratio).', 'model'],
        ['Online %', 'Online in the period / Est GMV prorated. Online = eCommerce + K2K + API (Rule 6): the cube changed labels mid-series and months before Aug 2025 use the per-channel names.', 'model'],
        ['Piso de red', 'If annualized Koronet exceeds the estimate, the estimate was wrong: it is replaced by the measured figure. Evaluated over a fixed 12-month window, so it does not move with the selector. Prevents penetration above 100%.', 'observed'],
      ]} />

      <h3 className={styles.h3}>Periods and trend</h3>
      <DefTable rows={[
        ['Periods', `Four explicit ranges anchored on the sell cube\u2019s last closed month (today ${period.to}): YTD, first half, the whole prior year, and the last 12 months. Every metric is computed strictly inside the range.`, 'observed'],
        ['Trend', 'Every metric is recomputed over the same months shifted 12 back, with the same formula and the same denominator. Amounts in %, percentages in percentage points. Suppressed when the cube does not cover the whole prior window: a partial baseline would invent growth.', 'observed'],
        ['Est GMV / Est Buy', 'Annual figure prorated to the selected period (annual × months / 12), a flat split because the cascade emits no monthly series. They carry a trend only when the source is Medido or Piso de red: there the estimate IS our sell cube and inherits its movement. With an ORA, FCS or external source there is no series behind it and no delta is shown.', 'model'],
      ]} />

      <h3 className={styles.h3}>Universe and data quality</h3>
      <DefTable rows={[
        ['WH universe', 'An explicit set of sfdc_ids: the canonical filter (Client + Wholesaler + product_tier) unioned with Christine/Facundo\u2019s curated sheet. It is a set rather than a rule because membership involves human judgement that no combination of fields encodes.', 'observed'],
        ['618 · outside portfolio', 'Accounts that only the external 618 universe research identifies as wholesalers. Recorded for review but excluded from the portfolio and its KPIs, and their business_type is not changed in Salesforce: the 618 defines a wholesaler as "sells wholesale to the trade", which in floral legitimately includes importers.', 'proxy'],
        ['Self-sales', 'Sell rows whose customer is the company itself: not sales, but its own purchases through Koronet channels mirrored in the sales table. Split out into self_sale_gmv and kept out of Koronet Sell.', 'observed'],
        ['Empty-cell reason', '"$0" and "no data" read the same but are very different decisions. Grey = the value is correctly zero (does not sell online, is not a K2K buyer). Amber with ⚠ = we do not know.', 'observed'],
      ]} />
    </div>
  );
}

function DefTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.defs}>
        <thead>
          <tr><th>Metric</th><th>How it is computed</th><th>Evidence</th></tr>
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
