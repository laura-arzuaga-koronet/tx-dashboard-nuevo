/**
 * Parity test against the legacy evidence_adapter_v3.js (vendored under tests/legacy/).
 *
 * The TS adapter deliberately differs from the legacy in two documented ways:
 *   1. Fees are filtered by period. The legacy summed every fee row per company,
 *      so its `fees_ytd_2026` included prior-year rows (see sql/README.md → Hallazgos).
 *      → fee-derived fields are excluded from the comparison and asserted separately.
 *   2. Rule 6 online channels: 'eCommerce' / 'K2K' / 'API' count as online (legacy: only 'Online').
 *      This only affects months before 2025-08, so YTD 2026 is unaffected — the monthly
 *      series online/offline split is compared from 2025-08 onwards only.
 *   3. "Current month" (sell.current_month, buy.sourcing_table.current_month) is the latest
 *      month INSIDE the period; the legacy used the latest month in all data, so an account
 *      with no activity in the period showed a stale month. Compared separately below.
 *
 * Everything else (identity, GMV reference, Piso de red, penetration, online %,
 * buy/list/sell/benchmarks sections) must be identical for every account.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { __resetForTests, evidenceAdapter } from '../src/data/adapter'
import { diskFetcher } from './helpers/diskFetcher'

const require = createRequire(import.meta.url)

interface LegacyAdapter {
  init(): Promise<void>
  getAllAccountIds(): string[]
  getAccountEvidence(id: string, tf: string): unknown
  isClientWholesaler(ev: unknown): boolean
}

let legacy: LegacyAdapter
const originalFetch = globalThis.fetch

/** Legacy field name → new period-relative name. */
const RENAMES: Record<string, string> = {
  koronet_sell_ytd: 'koronet_sell_period',
  koronet_buy_ytd: 'koronet_buy_period',
  sell_ytd_2025: 'sell_prior_period',
  buy_ytd_2025: 'buy_prior_period',
  sell_offline_ytd: 'sell_offline_period',
  buy_offline_ytd: 'buy_offline_period',
  fees_ytd_2026: 'fees_period',
  fees_ytd_2025: 'fees_prior_period',
  sell_online_ytd: 'sell_online_period',
  sell_total_ytd: 'sell_total_period',
  ytd_2026: 'period_total',
  ytd_2025: 'prior_period_total',
}

/** Fields whose values legitimately differ (fee fix, added fields, run date). */
const IGNORED = new Set([
  'as_of', '_timeframe', '_period',
  'fees_period', 'fees_prior_period', 'fees_by_channel', 'fees_yoy_pct', 'take_rate',
  'buy_yoy_delta',
  'current_month', 'prior_month', 'current_month_key', 'prior_month_key',
])

/** First month with the unified 'Online'/'Offline' labels in the sell cube. */
const UNIFIED_LABELS_FROM = '2025-08'

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Monthly sell totals before the label unification: keep the total, drop the split.
    if (typeof obj.month === 'string' && 'sell_online' in obj && obj.month < UNIFIED_LABELS_FROM) {
      return { month: obj.month, sell_gmv: obj.sell_gmv }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      const key = RENAMES[k] ?? k
      if (IGNORED.has(key)) continue
      out[key] = normalize(v)
    }
    return out
  }
  return value
}

beforeAll(async () => {
  globalThis.fetch = (async (url: string) => {
    const data = await diskFetcher(String(url))
    return { ok: data != null, status: data != null ? 200 : 404, json: async () => data } as Response
  }) as typeof fetch

  legacy = require(path.resolve(__dirname, 'legacy/evidence_adapter_v3.cjs')) as LegacyAdapter
  await legacy.init()

  __resetForTests()
  await evidenceAdapter.init(diskFetcher)
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('EvidenceAdapter parity with legacy JS (YTD)', () => {
  it('exposes the same account universe', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    expect(ids.length).toBeGreaterThan(100)
    expect(ids).toEqual(legacy.getAllAccountIds())
  })

  it('anchors periods on the sell cube (2026-07)', () => {
    expect(evidenceAdapter.getAnchorMonth()).toBe('2026-07')
    const p = evidenceAdapter.getPeriods()
    expect(p.ytd).toMatchObject({ from: '2026-01', to: '2026-07', months: 7, prior: { from: '2025-01', to: '2025-07' } })
    expect(p.prev_year).toMatchObject({ from: '2025-01', to: '2025-12', months: 12, prior: { from: '2024-01', to: '2024-12' } })
    expect(p.l12m).toMatchObject({ from: '2025-08', to: '2026-07', months: 12, prior: { from: '2024-08', to: '2025-07' } })
  })

  it('produces identical non-fee evidence for every account', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    const mismatches: string[] = []
    for (const id of ids) {
      const mine = normalize(evidenceAdapter.getAccountEvidence(id, 'ytd'))
      const theirs = normalize(legacy.getAccountEvidence(id, 'ytd'))
      try {
        expect(mine).toEqual(theirs)
      } catch {
        mismatches.push(id)
      }
    }
    expect(mismatches, `accounts with differences: ${mismatches.slice(0, 10).join(', ')}`).toEqual([])
  })

  it('current month is the latest month inside the period (legacy could show a stale month)', () => {
    const p = evidenceAdapter.getPeriods().ytd
    let stale = 0
    for (const id of evidenceAdapter.getAllAccountIds()) {
      const ev = evidenceAdapter.getAccountEvidence(id, 'ytd')!
      const cm = ev.sell?.current_month?.month
      if (cm) expect(cm >= p.from && cm <= p.to).toBe(true)
      const legacyCm = (legacy.getAccountEvidence(id, 'ytd') as { sell?: { current_month?: { month: string } } }).sell?.current_month?.month
      if (legacyCm && legacyCm < p.from) stale++
    }
    expect(stale).toBeGreaterThan(0) // documents the legacy behaviour this fixes
  })

  it('agrees on the client-wholesaler universe', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    const mine = ids.filter((id) => evidenceAdapter.isClientWholesaler(evidenceAdapter.getAccountEvidence(id)))
    const theirs = ids.filter((id) => legacy.isClientWholesaler(legacy.getAccountEvidence(id, 'ytd')))
    expect(mine).toEqual(theirs)
    expect(mine.length).toBeGreaterThan(0)
  })
})
