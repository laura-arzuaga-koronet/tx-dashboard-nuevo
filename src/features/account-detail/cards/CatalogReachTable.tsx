/**
 * Catalog reach — how much of what the account actually moves has ever gone
 * through an online channel, in three widths: categories, varieties, SKUs.
 *
 * Shared by SELL and BUY because the question is the same on both sides and the
 * answer is rarely the same: an account can have every category online and half
 * its varieties never listed there, which is precisely the finding the table
 * exists to surface.
 *
 * OFFLINE-ONLY IS A SET, NOT A SUBTRACTION
 * The legacy dashboard prints `offline − online`, a difference of two counts.
 * The two sets overlap almost always — a SKU sold through both channels is
 * counted twice and cancels — so that number came out negative for 141 of 330
 * accounts. Here it is `total − online`: what never touched an online channel.
 *
 * The table follows the period selector like everything else. Two things to keep
 * straight about that: COVERAGE % is comparable across all four periods, because
 * it is a ratio inside one window — the window length hits numerator and
 * denominator alike. ABSOLUTE COUNTS are only comparable between windows of the
 * same length: prev_year and l12m are both 12 months, ytd is 8 and h1 is 6. The
 * title carries the window so nobody compares six months against twelve without
 * noticing.
 *
 * CATEGORIES COUNTS LABELS, NOT CANONICAL CATEGORIES
 * `product_category_name` is free text per company: 3,997 distinct names, 2,739
 * of them used by a single company, and the core is full of variants of the
 * same thing (Rose / Roses / ROSE / ROSES are four). Each company is internally
 * consistent — only 1 pair in 17,432 collapses when normalized — so the per
 * account number is right: it counts the labels that account uses. What is
 * distorted is the network-median column: a company that labels finely looks
 * broader than one that labels coarsely, at the same real assortment.
 * The canonical taxonomy exists (PRODUCTS.category_network_code_id, 1274 =
 * "Rosa"); it is not reachable from SALES_SV, so recomputing this row on it
 * needs the join in sql/evidence/assortment_gap.sql.
 */
import type { CatalogDim, CatalogReach } from '../../../data/adapter/types';
import { fmtInt, fmtPct } from '../../../domain/format';
import { CardSection, CardTable } from '../EvidenceCard';

/** Below this the account is behind most of the network on that width. */
const BEHIND_MARGIN = 10;

function VsNetwork({ dim, unreliable }: { dim: CatalogDim; unreliable?: boolean }) {
  if (dim.coverage_pct == null || dim.network_median == null) return <>—</>;
  /* Con categorías de texto libre la mediana de la red compara etiquetas, no
     surtido: quien etiqueta fino parece más ancho. Se muestra igual —el número
     existe— pero sin el chip de distancia, que es lo que invita a leerlo como
     un veredicto. */
  if (unreliable) {
    return <>{fmtPct(dim.network_median, 0)} <span className="ev-state proxy">labels, not categories</span></>;
  }
  const d = dim.coverage_pct - dim.network_median;
  const tone = d <= -BEHIND_MARGIN ? 'gap' : d >= BEHIND_MARGIN ? 'observed' : 'proxy';
  const sign = d > 0 ? '+' : '';
  return (
    <>
      {fmtPct(dim.network_median, 0)}{' '}
      <span className={`ev-state ${tone}`}>{sign}{d.toFixed(0)} pp</span>
    </>
  );
}

export function CatalogReachTable(
  { reach, side, periodId }: { reach: CatalogReach; side: 'sell' | 'buy'; periodId: string },
) {
  /* El título es el del dashboard legacy — "online vs what they sell" — porque
     es como el equipo ya llama a esta comparación. Lo que cambia adentro es la
     aritmética del gap, no la pregunta. */
  const rows: [string, CatalogDim][] = [
    ['Categories', reach.categories],
    ['Varieties', reach.varieties],
    ['SKUs', reach.skus],
  ];
  const verb = side === 'sell' ? 'sold' : 'bought';

  /* The interesting shape is wide-but-shallow: the whole assortment is listed
     online while most of the depth behind it never is. Worth stating, because
     the categories row alone reads as "we're covered". */
  const cats = reach.categories.coverage_pct;
  const skus = reach.skus.coverage_pct;
  const shallow = cats != null && skus != null && cats - skus >= 25 && cats >= 50;
  /* Mientras la extracción agrupe por product_category_name, la fila de
     categorías cuenta etiquetas propias de cada empresa y no la taxonomía de
     red. El dato lo declara en su metadata, así que el aviso se apaga solo
     cuando se regenere con category_network_code_id. */
  const freeText = reach.category_key !== 'network_code';
  /* El archivo puede no traer el período elegido (los extractos viejos solo
     tienen l12m). Se muestra lo que hay y se dice, en vez de dejar que se lea
     como si fuera el período del selector. */
  const otroPeriodo = reach.period_id !== periodId;

  return (
    <CardSection
      title={`Online vs what they ${side === 'sell' ? 'sell' : 'buy'} · ${verb} through an online channel · ${reach.window}`}
    >
      <CardTable
        head={['', 'Total', 'Online', 'Offline-only', 'Coverage', 'Network median']}
        rows={rows.map(([label, d]) => [
          <strong>{label}</strong>,
          fmtInt(d.total),
          fmtInt(d.online),
          d.offline_only > 0
            ? <span className="ev-state gap">{fmtInt(d.offline_only)}</span>
            : '—',
          fmtPct(d.coverage_pct, 0),
          <VsNetwork dim={d} unreliable={freeText && label === 'Categories'} />,
        ])}
      />
      {otroPeriodo ? (
        <p className="ev-note">
          This extract does not carry the selected period, so the numbers above are for{' '}
          {reach.window}. Re-running the extract on the four-period queries fixes it.
        </p>
      ) : null}

      {freeText ? (
        <p className="ev-note">
          Categories are counted from each company's own free-text labels, so the network
          comparison on that row measures labelling style as much as assortment: 3,997 distinct
          names exist network-wide and Rose, Roses, ROSE and ROSES are four of them. The per
          account count is sound — each company spells consistently. Regenerating the extract on
          the canonical network code clears this.
        </p>
      ) : null}

      {shallow ? (
        <p className="ev-note">
          Wide but shallow: {fmtPct(cats, 0)} of the categories reach an online channel but only{' '}
          {fmtPct(skus, 0)} of the individual SKUs do — {fmtInt(reach.skus.offline_only)} SKUs were{' '}
          {verb} without ever appearing online.
        </p>
      ) : null}
    </CardSection>
  );
}
