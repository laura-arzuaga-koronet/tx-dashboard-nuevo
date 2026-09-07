/**
 * Period semantics: every metric is computed strictly inside the selected range.
 * Fees, sell and buy per period are cross-checked against raw sums of the JSON
 * cubes, so a regression in the adapter cannot hide behind the parity test.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { __resetForTests, evidenceAdapter } from '../src/data/adapter'
import { EXCLUDED_COMPANY_IDS } from '../src/data/adapter/files'
import type { PeriodId } from '../src/data/adapter/period'
import { diskFetcher } from './helpers/diskFetcher'

interface Row { company_id: string | number; month: string; [k: string]: unknown }

async function loadCube(file: string): Promise<Row[]> {
  const raw = await readFile(path.resolve(__dirname, '../public/data/current', file), 'utf8')
  return (JSON.parse(raw) as { data: Row[] }).data
}

function rawSum(rows: Row[], field: string, from: string, to: string, ids: Set<string>): number {
  let t = 0
  for (const r of rows) {
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
  { id: 'ytd', from: '2026-01', to: '2026-07', priorFrom: '2025-01', priorTo: '2025-07' },
  { id: 'prev_year', from: '2025-01', to: '2025-12', priorFrom: '2024-01', priorTo: '2024-12' },
  { id: 'l12m', from: '2025-08', to: '2026-07', priorFrom: '2024-08', priorTo: '2025-07' },
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
    expect(adapterSum(id, (p) => p.koronet_buy_period.value)).toBeCloseTo(rawSum(buy, 'buy_gmv', from, to, universe), 0)
    const covered = minMonth(sell) <= priorFrom
    const expected = covered ? rawSum(sell, 'sell_gmv', priorFrom, priorTo, universe) : 0
    expect(adapterSum(id, (p) => p.sell_prior_period.value)).toBeCloseTo(expected, 0)
  })
})

describe('fees fix vs legacy behaviour', () => {
  it('YTD 2026 fees are the 2026 rows only (~$1.47M network), not 2026 + 2025', () => {
    const ytd = adapterSum('ytd', (p) => p.fees_period.value)
    const all = rawSum(fees, 'fee_amount', '0000-00', '9999-99', universe)
    expect(ytd).toBeGreaterThan(1_400_000)
    expect(ytd).toBeLessThan(1_550_000)
    expect(ytd).toBeLessThan(all * 0.6) // legacy summed everything
  })

  it('YoY is suppressed when the prior range is not fully covered (2024 sell starts in Aug, fees start in 2025)', () => {
    const prev = evidenceAdapter.getAccountEvidence('44150', 'prev_year')!.potential!
    expect(prev.sell_prior_period.value).toBeNull()
    expect(prev.sell_yoy_delta).toBeNull()
    const l12m = evidenceAdapter.getAccountEvidence('44150', 'l12m')!.potential!
    expect(l12m.fees_prior_period.value).toBeNull()
    expect(l12m.fees_yoy_pct.value).toBeNull()
    expect(l12m.sell_yoy_delta).not.toBeNull() // sell covers Aug-2024 → Jul-2025
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
    const raw = rawSum(sell, 'sell_gmv', '2025-08', '2026-07', new Set(['44150']))
    expect(l12m.koronet_sell_period.value).toBeCloseTo(raw, 0)
    expect(l12m.sell_penetration.ev).toBe('tautological')
  })
})
