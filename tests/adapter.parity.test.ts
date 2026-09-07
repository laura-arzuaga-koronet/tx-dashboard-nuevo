/**
 * Parity test: the TypeScript adapter must produce the same evidence as the
 * legacy evidence_adapter_v3.js for every account and every timeframe.
 *
 * The legacy file is vendored under tests/legacy/ (CommonJS) and driven with a
 * stubbed global `fetch` that reads from public/data.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { __resetForTests, evidenceAdapter } from '../src/data/adapter'
import type { Timeframe } from '../src/data/adapter/types'
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

/** Strip fields that legitimately differ (today's date) before comparing. */
function normalize(ev: unknown): unknown {
  return JSON.parse(
    JSON.stringify(ev, (key, value) => (key === 'as_of' ? undefined : value)),
  )
}

beforeAll(async () => {
  // Legacy adapter fetches 'data/...' relative URLs — serve them from public/.
  globalThis.fetch = (async (url: string) => {
    const data = await diskFetcher(String(url))
    return {
      ok: data != null,
      status: data != null ? 200 : 404,
      json: async () => data,
    } as Response
  }) as typeof fetch

  legacy = require(path.resolve(__dirname, 'legacy/evidence_adapter_v3.cjs')) as LegacyAdapter
  await legacy.init()

  __resetForTests()
  await evidenceAdapter.init(diskFetcher)
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('EvidenceAdapter parity with legacy JS', () => {
  it('exposes the same account universe', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    expect(ids.length).toBeGreaterThan(100)
    expect(ids).toEqual(legacy.getAllAccountIds())
  })

  const timeframes: Timeframe[] = ['ytd', 'current_month', 'prior_month']

  for (const tf of timeframes) {
    it(`produces identical evidence for every account (timeframe=${tf})`, () => {
      const ids = evidenceAdapter.getAllAccountIds()
      const mismatches: string[] = []
      for (const id of ids) {
        const mine = normalize(evidenceAdapter.getAccountEvidence(id, tf))
        const theirs = normalize(legacy.getAccountEvidence(id, tf))
        try {
          expect(mine).toEqual(theirs)
        } catch {
          mismatches.push(id)
        }
      }
      expect(mismatches, `accounts with differences: ${mismatches.slice(0, 10).join(', ')}`).toEqual([])
    })
  }

  it('agrees on the client-wholesaler universe', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    const mine = ids.filter((id) => evidenceAdapter.isClientWholesaler(evidenceAdapter.getAccountEvidence(id)))
    const theirs = ids.filter((id) => legacy.isClientWholesaler(legacy.getAccountEvidence(id, 'ytd')))
    expect(mine).toEqual(theirs)
    expect(mine.length).toBeGreaterThan(0)
  })
})
