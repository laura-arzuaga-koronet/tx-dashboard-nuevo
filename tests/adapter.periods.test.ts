/**
 * Period semantics: every metric is computed strictly inside the selected range.
 * Fees, sell and buy per period are cross-checked against raw sums of the JSON
 * cubes, so a regression in the adapter cannot hide behind the parity test.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { __resetForTests, evidenceAdapter } from '../src/data/adapter'
import { EXCLUDED_COMPANY_IDS, isBadCubeRow } from '../src/data/adapter/files'
import type { PeriodId } from '../src/data/adapter/period'
import { diskFetcher } from './helpers/diskFetcher'

interface Row { company_id: string | number; month: string; [k: string]: unknown }

async function loadCube(file: string): Promise<Row[]> {
  const raw = await readFile(path.resolve(__dirname, '../public/data/current', file), 'utf8')
  return (JSON.parse(raw) as { data: Row[] }).data
}

/** Raw sum over the JSON, minus the known-bad company-months the adapter drops.
 *  Without this the buy cube differs by $586M: Ninfa Flowers reports Apr–Oct 2025
 *  three orders of magnitude above its own baseline. */
function rawSum(rows: Row[], field: string, from: string, to: string, ids: Set<string>, cube: 'sell' | 'buy' = 'sell'): number {
  let t = 0
  for (const r of rows) {
    if (isBadCubeRow(cube, String(r.company_id), r.month)) continue
    if (r.month >= from && r.month <= to && ids.has(String(r.company_id))) t += Number(r[field]) || 0
  }
  return t
}

function minMonth(rows: Row[]): string {
  return rows.reduce((m, r) => (r.month < m ? r.month : m), '9999-99')
}

function adapterSum(periodId: PeriodId, pick: (p: NonNullable<ReturnType<typeof evidenceAdapter.getAccountEvidence>>['potential']) => number | null): number {
  let t = 0
  for (const id of evidenceAdapter.getAllAccountIds()) {
    const ev = evidenceAdapter.getAccountEvidence(id, periodId)
    const v = ev?.potential ? pick(ev.potential) : null
    if (v) t += v
  }
  return t
}

let fees: Row[], sell: Row[], buy: Row[]
let universe: Set<string>

beforeAll(async () => {
  __resetForTests()
  await evidenceAdapter.init(diskFetcher)
  ;[fees, sell, buy] = await Promise.all([loadCube('fees_monthly.json'), loadCube('sell_monthly.json'), loadCube('buy_monthly.json')])
  universe = new Set(evidenceAdapter.getAllAccountIds())
  // sanity: excluded demo ids never appear in the universe
  for (const id of EXCLUDED_COMPANY_IDS) expect(universe.has(id)).toBe(false)
})

const CASES: { id: PeriodId; from: string; to: string; priorFrom: string; priorTo: string }[] = [
  { id: 'ytd', from: '2026-01', to: '2026-08', priorFrom: '2025-01', priorTo: '2025-08' },
  { id: 'h1', from: '2026-01', to: '2026-06', priorFrom: '2025-01', priorTo: '2025-06' },
  { id: 'prev_year', from: '2025-01', to: '2025-12', priorFrom: '2024-01', priorTo: '2024-12' },
  { id: 'l12m', from: '2025-09', to: '2026-08', priorFrom: '2024-09', priorTo: '2025-08' },
]

describe.each(CASES)('period $id', ({ id, from, to, priorFrom, priorTo }) => {
  it('fees equal the raw cube sum inside the range (no prior-year leakage)', () => {
    const expected = rawSum(fees, 'fee_amount', from, to, universe)
    expect(adapterSum(id, (p) => p.fees_period.value)).toBeCloseTo(expected, 0)
    expect(expected).toBeGreaterThan(0)
  })

  it('prior-period fees equal the raw sum of the shifted range, or null when the data does not cover it', () => {
    const covered = minMonth(fees) <= priorFrom
    const expected = covered ? rawSum(fees, 'fee_amount', priorFrom, priorTo, universe) : 0
    expect(adapterSum(id, (p) => p.fees_prior_period.value)).toBeCloseTo(expected, 0)
  })

  it('sell and buy equal the raw cube sums inside the range', () => {
    expect(adapterSum(id, (p) => p.koronet_sell_period.value)).toBeCloseTo(rawSum(sell, 'sell_gmv', from, to, universe), 0)
    expect(adapterSum(id, (p) => p.koronet_buy_period.value)).toBeCloseTo(rawSum(buy, 'buy_gmv', from, to, universe, 'buy'), 0)
    const covered = minMonth(sell) <= priorFrom
    const expected = covered ? rawSum(sell, 'sell_gmv', priorFrom, priorTo, universe) : 0
    expect(adapterSum(id, (p) => p.sell_prior_period.value)).toBeCloseTo(expected, 0)
  })
})

describe('fees fix vs legacy behaviour', () => {
  it('YTD 2026 fees are the 2026 rows only (~$1.47M network), not 2026 + 2025', () => {
    // Ene–ago 2026 ahora que el cubo llega a 2026-08 (antes ene–jul = $1.45M).
    const ytd = adapterSum('ytd', (p) => p.fees_period.value)
    const all = rawSum(fees, 'fee_amount', '0000-00', '9999-99', universe)
    expect(ytd).toBeGreaterThan(1_550_000)
    expect(ytd).toBeLessThan(1_750_000)
    expect(ytd).toBeLessThan(all * 0.6) // legacy summed everything
  })

  it('every period now has a YoY baseline: the four cubes were regenerated to 2024-01', () => {
    // Antes los cubos empezaban en meses distintos (sell 2024-08, buy 2024-11,
    // fees 2025-01), así que "Full year 2025" y "Last 12 months" quedaban sin
    // ninguna comparación. Ahora los cuatro arrancan en 2024-01.
    const prev = evidenceAdapter.getAccountEvidence('44150', 'prev_year')!.potential!
    expect(prev.sell_prior_period.value).not.toBeNull()
    expect(prev.sell_yoy_delta).not.toBeNull()
    const l12m = evidenceAdapter.getAccountEvidence('44150', 'l12m')!.potential!
    expect(l12m.fees_prior_period.value).not.toBeNull()
    expect(l12m.sell_yoy_delta).not.toBeNull()
  })

  it('fees YoY is now available for YTD', () => {
    let withYoy = 0
    for (const id of evidenceAdapter.getAllAccountIds()) {
      const p = evidenceAdapter.getAccountEvidence(id, 'ytd')?.potential
      if (p?.fees_yoy_pct.value != null) withYoy++
    }
    expect(withYoy).toBeGreaterThan(50)
  })

  it('full-year and L12M periods annualize with factor 1 when 12 months of data exist', () => {
    // Kennicott (44150): Medido → penetration is tautological (100) in every period; sell must be a plain sum.
    const l12m = evidenceAdapter.getAccountEvidence('44150', 'l12m')!.potential!
    const raw = rawSum(sell, 'sell_gmv', '2025-09', '2026-08', new Set(['44150']))
    expect(l12m.koronet_sell_period.value).toBeCloseTo(raw, 0)
    expect(l12m.sell_penetration.ev).toBe('tautological')
  })
})

describe('exclusiones de calidad de datos', () => {
  it('drops Ninfa Flowers Apr–Oct 2025 from the buy cube', () => {
    // $268.182.503 en abril de 2025 contra meses de $6K–$627K: era el 20% del cubo.
    const raw = buy.filter((r) => String(r.company_id) === '640977'
      && r.month >= '2025-04' && r.month <= '2025-10')
      .reduce((t, r) => t + (Number(r.buy_gmv) || 0), 0)
    expect(raw).toBeGreaterThan(500_000_000)

    const ev = evidenceAdapter.getAccountEvidence('640977', 'prev_year')
    expect(ev?.potential?.koronet_buy_period.value ?? 0).toBeLessThan(1_000_000)
  })

  it('keeps self-sales out of sell GMV and exposes them separately', () => {
    // R&W Wholesale "se vende" a sí misma: son sus compras por K2K espejadas.
    const ev = evidenceAdapter.getAccountEvidence('650536', 'l12m')!.potential!
    expect(ev.self_sale_gmv.value).toBeGreaterThan(400_000)
    expect(ev.koronet_sell_period.value ?? 0).toBeLessThan(ev.self_sale_gmv.value!)
  })

  it('indirect fees use each seller\'s realised rate, not a flat 1.5%', () => {
    let attributed = 0, fees = 0
    for (const id of evidenceAdapter.getAllAccountIds()) {
      const p = evidenceAdapter.getAccountEvidence(id, 'l12m')?.potential
      attributed += p?.buy_attributed.value ?? 0
      fees += p?.fees_indirect.value ?? 0
    }
    expect(attributed).toBeGreaterThan(100_000_000)
    // La tasa efectiva queda claramente por debajo del 1,5% plano.
    expect(fees / attributed).toBeLessThan(0.014)
    expect(fees / attributed).toBeGreaterThan(0.005)
  })
})
