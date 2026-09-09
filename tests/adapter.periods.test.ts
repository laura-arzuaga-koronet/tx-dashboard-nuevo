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
import { getGmvBand } from '../src/domain/metrics'
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
  /* El bug: el Est GMV salía anual en los cuatro períodos, así que la columna
     no se movía con el selector y el take rate mezclaba unidades — fees de 8
     meses sobre flujo de 12. */
  it('prorates Est GMV to the period and keeps the annual figure alongside', () => {
    const ids = evidenceAdapter.getAllAccountIds()
    const sum = (period: PeriodId, pick: 'value' | 'annual') => {
      let t = 0
      for (const id of ids) {
        const g = evidenceAdapter.getAccountEvidence(id, period)?.potential?.gmv_reference
        t += g?.[pick] ?? 0
      }
      return t
    }
    const annual = sum('l12m', 'annual')
    expect(annual).toBeGreaterThan(0)

    // 12-month windows: factor 1. YTD through August: 8/12. H1: 6/12.
    expect(sum('l12m', 'value')).toBeCloseTo(annual, -3)
    expect(sum('ytd', 'value') / annual).toBeCloseTo(8 / 12, 3)
    expect(sum('h1', 'value') / annual).toBeCloseTo(6 / 12, 3)

    // El anual NO se mueve con el período: es lo que segmenta el tamaño.
    expect(sum('ytd', 'annual')).toBeCloseTo(annual, -3)
    expect(sum('h1', 'annual')).toBeCloseTo(annual, -3)
  })

  it('keeps GMV bands stable across periods', () => {
    // Una cuenta no puede cambiar de banda por cambiar la ventana.
    for (const id of evidenceAdapter.getAllAccountIds().slice(0, 300)) {
      const a = getGmvBand(evidenceAdapter.getAccountEvidence(id, 'l12m'))
      const b = getGmvBand(evidenceAdapter.getAccountEvidence(id, 'h1'))
      expect(b).toBe(a)
    }
  })

  it('take rate no longer shrinks purely because the window is shorter', () => {
    // Con denominador anual, el take rate de YTD salía 12/8 más bajo que el de
    // un período completo por puro desajuste de unidades.
    const tr = (period: PeriodId) => {
      let fees = 0, flow = 0
      for (const id of evidenceAdapter.getAllAccountIds()) {
        const p = evidenceAdapter.getAccountEvidence(id, period)?.potential
        fees += (p?.fees_direct.value ?? 0) + (p?.fees_indirect.value ?? 0)
        flow += (p?.gmv_reference.value ?? 0) + (p?.buy_gmv_estimated.value ?? 0)
      }
      return flow > 0 ? fees / flow : 0
    }
    const ytd = tr('ytd')
    const l12m = tr('l12m')
    expect(ytd).toBeGreaterThan(0)
    // Mismo orden de magnitud: el ratio ya no depende del largo de la ventana.
    expect(ytd / l12m).toBeGreaterThan(0.6)
    expect(ytd / l12m).toBeLessThan(1.7)
  })
  /* Metropetals: gmv_source dice "Medido" ($1,05M anual) pero el cubo de sell
     mide $579K en doce meses y $836K en TODO el histórico. La penetración se
     mostraba como ~100% tautológica sin verificar nunca esa afirmación. */
  it('does not claim a tautological penetration when the label disagrees with the cube', () => {
    const p = evidenceAdapter.getAccountEvidence('600558', 'ytd')!.potential!
    expect(p.gmv_reference.source).toBe('Medido')
    expect(p.gmv_reference.unverified).toBe(true)
    expect(p.sell_penetration.ev).not.toBe('tautological')
    // 458K / 701K ≈ 65%, no 100%
    expect(p.sell_penetration.value).toBeGreaterThan(55)
    expect(p.sell_penetration.value).toBeLessThan(75)
  })

  it('keeps the tautology where the label does agree with the cube', () => {
    let verificadas = 0, noVerificadas = 0
    for (const id of evidenceAdapter.getAllAccountIds()) {
      const p = evidenceAdapter.getAccountEvidence(id, 'ytd')?.potential
      if (!p || !/^(Medido|Piso)/.test(p.gmv_reference.source ?? '')) continue
      if (p.gmv_reference.unverified) noVerificadas++
      else verificadas++
    }
    // Ni todo verificado (sería no haber cambiado nada) ni todo lo contrario.
    expect(verificadas).toBeGreaterThan(0)
    expect(noVerificadas).toBeGreaterThan(0)
  })

  it('labels Est Buy by where it actually came from', () => {
    // Metropetals: accounts_v3 trae $473K (= 45% de $1,05M), pero la compra
    // medida anualizada da $556K y la regla del piso la reemplaza.
    const p = evidenceAdapter.getAccountEvidence('600558', 'ytd')!.potential!
    expect(p.buy_gmv_estimated.source).toBe('floor')
    expect(p.buy_gmv_estimated.annual).toBeGreaterThan((p.gmv_reference.annual ?? 0) * 0.45)
    // Y entonces la penetración de compra es una identidad, no un logro.
    expect(p.buy_penetration.ev).toBe('tautological')
  })
})
