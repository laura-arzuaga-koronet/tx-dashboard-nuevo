/**
 * Card 4 · LIST — what the account actually has published: inventory by type and
 * division, how recently each variety last sold, how deep the forward (prebook)
 * book is, and the configuration flags that gate all of it.
 *
 * Ported from the legacy `renderListCard`. Two legacy blocks are dropped here:
 * the online-vs-offline comparison table (categories and SKUs live in the BUY
 * card, which owns that evidence) and the "TAM not visible" pills, whose
 * proportional allocation is a directional scenario rather than evidence — the
 * domain models it as `tam_lost: null`.
 */
import type { ReactNode } from 'react';
import type { AccountEvidence, FreshnessGroup, LooseRecord } from '../../../data/adapter/types';
import { evValue, fmtInt, fmtMoney, fmtPct } from '../../../domain/format';
import { CardFocus, CardGap, CardNext, CardSection, CardTable, EvidenceCard } from '../EvidenceCard';

/** Buckets as the temporal cube emits them, freshest first. */
const FRESHNESS_BUCKETS = ['0-30d', '31-60d', '61-90d', '91-120d', '121-180d', '180d+'] as const;
const HORIZON_BUCKETS = ['1-7d', '8-14d', '15-30d', '31-60d', '61-90d', '90d+'] as const;

/** Below this MaxAge the catalog cannot be listed forward. */
const MAX_AGE_TARGET = 30;
/** Varieties whose last sale is older than this are stale supply. */
const STALE_BUCKETS = new Set(['91-120d', '121-180d', '180d+']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(source: unknown, key: string): number | null {
  const rec = asRecord(source);
  if (!rec) return null;
  const v = rec[key];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Config flags arrive as booleans, "true"/"false" strings or 0/1 across generations. */
function flag(source: unknown, key: string): boolean | null {
  const rec = asRecord(source);
  if (!rec) return null;
  const v = rec[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  }
  return null;
}

/** MaxAge lives under three different names across config generations. */
function readMaxAge(raw: LooseRecord | null): number | null {
  for (const key of ['ecommerce_max_age', 'max_age_sell', 'MaxAge']) {
    const n = num(raw, key);
    if (n != null) return Math.trunc(n);
  }
  return null;
}

/** Rows of an inventory breakdown keyed by type or division. */
function breakdownRows(source: unknown): ReactNode[][] {
  const rec = asRecord(source);
  if (!rec) return [];
  return Object.entries(rec)
    .map(([name, raw]) => ({
      name,
      items: num(raw, 'item_count'),
      products: num(raw, 'unique_products'),
      categories: num(raw, 'unique_categories'),
      varieties: num(raw, 'unique_varieties'),
      units: num(raw, 'total_units'),
    }))
    .filter((r) => r.items != null && r.items > 0)
    .sort((a, b) => (b.items ?? 0) - (a.items ?? 0))
    .map((r) => [r.name, fmtInt(r.items), fmtInt(r.products), fmtInt(r.categories), fmtInt(r.varieties), fmtInt(r.units)]);
}

function bucketCount(group: FreshnessGroup, bucket: string): number {
  return group.buckets[bucket]?.variety_count ?? 0;
}

function staleShare(group: FreshnessGroup | null): number | null {
  if (!group || group.total_varieties <= 0) return null;
  let stale = 0;
  for (const [key, entry] of Object.entries(group.buckets)) {
    if (STALE_BUCKETS.has(key)) stale += entry.variety_count ?? 0;
  }
  return (stale / group.total_varieties) * 100;
}

function share(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null;
}

export function ListCard({ ev }: { ev: AccountEvidence }) {
  const list = ev.list;
  const p = ev.potential;

  if (!list) {
    return (
      <EvidenceCard label="Card 4 · LIST" headline="Sin datos de catálogo" defaultOpen={false}>
        <CardGap>No hay evidencia de inventario ni de configuración para esta cuenta.</CardGap>
      </EvidenceCard>
    );
  }

  const sellOffline = p ? evValue(p.sell_offline_period) : null;

  const inventory = list.inventory_current?.value ?? null;
  const freshness = list.variety_freshness?.value ?? null;
  const forward = list.forward_inventory?.value ?? null;
  const config = list.config?.value ?? null;
  const cfgRaw = config?.raw ?? null;

  const onlineVar = freshness?.online?.total_varieties ?? null;
  const offlineVar = freshness?.offline?.total_varieties ?? null;
  const varietyGap = onlineVar != null && offlineVar != null ? Math.max(0, offlineVar - onlineVar) : null;
  const onlineCoverage = onlineVar != null && offlineVar != null && offlineVar > 0 ? share(onlineVar, offlineVar) : null;

  const maxAge = readMaxAge(cfgRaw);
  const maxAgeOk = maxAge != null && maxAge >= MAX_AGE_TARGET;

  // The reality flag (did they actually sell bunches online?) outranks the config flag.
  const bunchesReality = flag(config?.bunches_reality, 'actually_sells_bunches_ecom');
  const bunchesFlag = flag(cfgRaw, 'is_on_hand_inventory_units') ?? flag(cfgRaw, 'sell_in_bunches') ?? flag(cfgRaw, 'bunches');
  const bunchesOn = bunchesReality ?? bunchesFlag;

  const eshops = flag(cfgRaw, 'eshops');
  const futureSales = flag(cfgRaw, 'ecommerce_future_sales_enabled') ?? flag(cfgRaw, 'future_sales_enabled');

  const headline = [
    onlineCoverage != null ? `Publica el ${fmtPct(onlineCoverage, 0)} de las variedades que vende` : null,
    varietyGap ? `${fmtInt(varietyGap)} variedades solo offline` : null,
    bunchesOn === false ? 'bunches OFF' : null,
  ].filter(Boolean).join(' · ') || 'Catálogo sin cobertura medida';

  const focus = <>
    {onlineCoverage != null
      ? <>Muestra online <strong>{fmtPct(onlineCoverage, 0)}</strong> de lo que vende.</>
      : <>La profundidad del catálogo online no se puede medir con la evidencia disponible.</>}
    {varietyGap ? ` ${fmtInt(varietyGap)} variedades quedan fuera del canal online.` : ''}
    {bunchesOn === false && sellOffline
      ? ` Bunches está apagado: el TAM retail queda bloqueado sobre ${fmtMoney(sellOffline, true)} de venta offline.`
      : ''}
    {maxAge != null && !maxAgeOk
      ? ` MaxAge en ${fmtInt(maxAge)} días bloquea el listado forward (necesita ${MAX_AGE_TARGET}+).`
      : ''}
  </>;

  /* ── Inventario actual ── */
  const typeRows = breakdownRows(inventory?.by_type);
  const divisionRows = breakdownRows(inventory?.by_division);
  const totalItems = num(inventory?.totals, 'total_items');
  const totalUnits = num(inventory?.totals, 'total_units');

  /* ── Frescura de variedades ── */
  const freshnessRows = freshness && (freshness.online || freshness.offline)
    ? FRESHNESS_BUCKETS.map((b) => {
        const on = freshness.online ? bucketCount(freshness.online, b) : 0;
        const off = freshness.offline ? bucketCount(freshness.offline, b) : 0;
        return [
          b,
          freshness.online ? `${fmtInt(on)} (${fmtPct(share(on, freshness.online.total_varieties), 0)})` : '—',
          freshness.offline ? `${fmtInt(off)} (${fmtPct(share(off, freshness.offline.total_varieties), 0)})` : '—',
        ];
      })
    : [];
  const staleOnline = staleShare(freshness?.online ?? null);
  const staleOffline = staleShare(freshness?.offline ?? null);

  /* ── Inventario forward (prebooks) ── */
  const forwardRows: ReactNode[][] = [];
  let forwardValue = 0;
  let forwardLines = 0;
  if (forward) {
    for (const bucket of HORIZON_BUCKETS) {
      const entry = forward.by_bucket[bucket];
      if (!entry) continue;
      const lines = num(entry, 'prebook_lines');
      const value = num(entry, 'total_value');
      forwardLines += lines ?? 0;
      forwardValue += value ?? 0;
      forwardRows.push([
        bucket,
        fmtInt(lines),
        fmtMoney(value, true),
        fmtInt(num(entry, 'distinct_vendors')),
        fmtInt(num(entry, 'distinct_products')),
      ]);
    }
  }

  /* ── Configuración y sus problemas ── */
  const configRows: ReactNode[][] = [];
  const issues: string[] = [];
  if (cfgRaw) {
    configRows.push([
      'MaxAge',
      maxAge != null ? `${fmtInt(maxAge)} días` : '—',
      maxAge == null ? 'sin dato' : maxAgeOk ? 'apto para listado forward' : `necesita ${MAX_AGE_TARGET}+ días`,
    ]);
    configRows.push([
      'Bunches',
      bunchesOn == null ? '—' : bunchesOn ? 'ON' : 'OFF',
      bunchesReality != null ? 'medido sobre ventas ecom reales' : 'según flag de configuración',
    ]);
    configRows.push([
      'eShop',
      eshops == null ? '—' : eshops ? 'ON' : 'OFF',
      eshops ? 'tienda publicada' : 'sin tienda publicada',
    ]);
    configRows.push([
      'Venta forward',
      futureSales == null ? '—' : futureSales ? 'ON' : 'OFF',
      futureSales ? 'inventario forward visible' : 'las órdenes forward valen $0',
    ]);

    if (maxAge != null && !maxAgeOk) issues.push(`MaxAge en ${fmtInt(maxAge)} días: bloquea el listado forward del catálogo.`);
    if (bunchesOn === false) {
      issues.push(sellOffline
        ? `Bunches apagado: el TAM retail queda invisible sobre ${fmtMoney(sellOffline, true)} de venta offline.`
        : 'Bunches apagado: el TAM retail queda invisible.');
    }
    if (eshops === false) issues.push('Sin eShop publicada: no hay vidriera propia donde mostrar el inventario.');
    if (futureSales === false) issues.push('Venta forward apagada: las órdenes anticipadas no se pueden capturar.');
  }

  return (
    <EvidenceCard label="Card 4 · LIST" headline={headline}>
      <CardFocus><strong>Foco:</strong> {focus}</CardFocus>

      {typeRows.length || divisionRows.length ? (
        <CardSection title="Inventario actual publicado">
          {typeRows.length ? (
            <CardTable
              head={['Por tipo', 'Ítems', 'Productos', 'Categorías', 'Variedades', 'Unidades']}
              rows={typeRows}
            />
          ) : null}
          {divisionRows.length ? (
            <CardTable
              head={['Por división', 'Ítems', 'Productos', 'Categorías', 'Variedades', 'Unidades']}
              rows={divisionRows}
            />
          ) : null}
          <CardGap>
            Total: {fmtInt(totalItems)} ítems · {fmtInt(totalUnits)} unidades.
            Los conteos únicos no se suman entre tipos (requieren deduplicación cruzada).
          </CardGap>
        </CardSection>
      ) : (
        <CardGap>Sin inventario publicado relevado para esta cuenta.</CardGap>
      )}

      {freshnessRows.length ? (
        <CardSection title="Frescura de variedades — cuándo vendió por última vez cada variedad">
          <CardTable head={['Antigüedad', 'Online (variedades)', 'Offline (variedades)']} rows={freshnessRows} />
          <CardGap>
            {fmtInt(onlineVar)} variedades online vs {fmtInt(offlineVar)} offline
            {varietyGap ? ` — ${fmtInt(varietyGap)} de brecha` : ''}.
            {staleOnline != null ? ` ${fmtPct(staleOnline, 0)} del catálogo online lleva 90+ días sin vender` : ''}
            {staleOffline != null ? `, ${fmtPct(staleOffline, 0)} del offline` : ''}.
          </CardGap>
        </CardSection>
      ) : null}

      {forwardRows.length ? (
        <CardSection title="Profundidad forward — prebooks por horizonte">
          <CardTable head={['Horizonte', 'Líneas', 'Valor', 'Vendors', 'Productos']} rows={forwardRows} />
          <CardGap>
            {fmtInt(forwardLines)} líneas de prebook por {fmtMoney(forwardValue, true)} comprometidas hacia adelante.
            {futureSales === false ? ' La venta forward está apagada, así que este inventario no se puede listar.' : ''}
          </CardGap>
        </CardSection>
      ) : (
        <CardGap>Sin prebooks en el horizonte relevado: la cuenta no compromete inventario hacia adelante.</CardGap>
      )}

      {configRows.length ? (
        <CardSection title="Configuración de la cuenta">
          <CardTable head={['Ajuste', 'Estado', 'Qué implica']} rows={configRows} />
          {issues.length ? (
            <CardGap>
              Problemas detectados: {issues.join(' ')}
            </CardGap>
          ) : null}
        </CardSection>
      ) : (
        <CardGap>Sin fila en config_evidence_v2: no se puede auditar la configuración de esta cuenta.</CardGap>
      )}

      <CardNext>
        → Continúa en <strong>SELL</strong>: ¿sus compradores convierten lo que ya está online?
      </CardNext>
    </EvidenceCard>
  );
}
