#!/usr/bin/env python3
"""
Regenera los dos JSON que son DERIVADOS de otros archivos del repo, sin tocar
Snowflake: `gmv_pacing.json` y `benchmarks_v2.json`.

Los dos estaban viejos (27 y 34 días) no porque hiciera falta re-extraer nada,
sino porque nadie los volvió a calcular después de regenerar los cubos. Sus
insumos ya están frescos:

  gmv_pacing     ← current/sell_monthly.json + accounts_v3.json
  benchmarks_v2  ← los cubos (1, 2) + buyers_evidence_v2 (3-6) + temporal_evidence_v2 (7, 8)

Los ocho benchmarks son percentiles sobre TODA la red presente en los cubos, que
es la cohorte con la que se calcularon antes: las tarjetas dicen "network median"
y cambiarla alteraría el significado de cada comparación ya publicada.

USO
---
    python3 scripts/rebuild_derived.py [--dry-run]
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import statistics
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"
ONLINE_CHANNELS = {"Online", "eCommerce", "K2K", "API"}


def load(name: str):
    with open(DATA / name, encoding="utf-8") as fh:
        return json.load(fh)


def dump(name: str, doc, dry: bool) -> None:
    if dry:
        print(f"   --dry-run: no se escribió {name}")
        return
    with open(DATA / name, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"   escrito {name}")


def shift_month(key: str, delta: int) -> str:
    y, m = (int(x) for x in key.split("-"))
    total = y * 12 + (m - 1) + delta
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def pct(values: list[float], q: float):
    """Percentil por interpolación lineal; None si no hay muestra."""
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return round(xs[0], 2)
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo), 2)


def build_pacing(cube, accounts, dry: bool) -> None:
    anchor = cube["_meta"]["period_to"]
    win_from = shift_month(anchor, -11)
    by = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in cube["data"]:
        if win_from <= r["month"] <= anchor:
            by[str(r["company_id"])][r["month"]] += float(r.get("sell_gmv") or 0)

    idx = {str(a["company_id"]): a for a in accounts if a.get("company_id") is not None}
    out = []
    for cid, meses in by.items():
        activos = {m: v for m, v in meses.items() if v > 0}
        if not activos:
            continue
        total = sum(activos.values())
        n = len(activos)
        dias = n * 30
        tasa = total / dias
        a = idx.get(cid, {})
        ref = a.get("gmv_reference")
        out.append({
            "company_id": cid,
            "company_name": a.get("company_name"),
            "total_sell_observed": round(total),
            "months_observed": n,
            "days_observed": dias,
            "daily_rate": round(tasa),
            "annual_pace": round(tasa * 365),
            # 240 días ≈ 8 meses: por debajo de eso el ritmo diario lo dominan
            # unos pocos meses y proyectarlo a un año dice poco.
            "confidence": "Alta" if dias >= 240 else ("Media" if dias >= 120 else "Baja"),
            "gmv_reference": ref,
            "gmv_source": a.get("gmv_source"),
            "pace_vs_ref": round(tasa * 365 / float(ref) * 100) if ref else None,
        })
    out.sort(key=lambda r: (r["company_name"] or "").lower())
    doc = {
        "_meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_derived.py",
            "source": "current/sell_monthly.json + accounts_v3.json",
            "window": f"{win_from}..{anchor}",
            "accounts": len(out),
        },
        "pacing": out,
    }
    print(f"gmv_pacing: {len(out)} cuentas (antes 349)")
    dump("gmv_pacing.json", doc, dry)


def build_benchmarks(cube_sell, cube_buy, accounts, universe, buyers, temporal, dry: bool) -> None:
    """
    Cohorte: TODA la red, no el portafolio.

    Las tarjetas comparan cada cuenta contra "network median / p75", y así se
    calculaban antes (sobre las 434 empresas del sell domain). Restringirlo al
    portafolio de wholesalers cambiaría el significado de cada comparación ya
    publicada: los wholesalers son K2K-intensivos y su mediana de online % da
    100%, contra 28,6% de la red.
    """
    anchor = cube_sell["_meta"]["period_to"]
    ytd_from = f"{anchor[:4]}-01"
    ids = {str(r["company_id"]) for r in cube_sell["data"]} | {str(r["company_id"]) for r in cube_buy["data"]}
    nombres = {str(a["company_id"]): a.get("company_name") for a in accounts if a.get("company_id") is not None}

    def nombre(cid: str):
        return nombres.get(cid) or cid

    def online_pct(cube, field, is_online):
        tot = collections.defaultdict(float)
        onl = collections.defaultdict(float)
        for r in cube["data"]:
            cid = str(r["company_id"])
            if cid not in ids or not (ytd_from <= r["month"] <= anchor):
                continue
            v = float(r.get(field) or 0)
            tot[cid] += v
            onl[cid] += is_online(r, v)
        return [(onl[c] / tot[c] * 100, nombre(c)) for c in tot if tot[c] > 0]

    sell_online = online_pct(cube_sell, "sell_gmv", lambda r, v: v if r.get("channel") in ONLINE_CHANNELS else 0.0)
    buy_online = online_pct(cube_buy, "buy_gmv", lambda r, _v: float(r.get("buy_online") or 0))

    def from_buyers(section: str, field: str):
        # `companies` está indexado por NOMBRE, no por id: el id va adentro del registro.
        vals = []
        for rec in buyers.get("companies", {}).values():
            if str(rec.get("company_id")) not in ids:
                continue
            v = (rec.get(section) or {}).get(field)
            if isinstance(v, (int, float)):
                vals.append((float(v), rec.get("company_name") or nombre(str(rec.get("company_id")))))
        return vals

    repeat = from_buyers("repeat_rate", "repeat_rate_pct")
    conc = from_buyers("concentration", "top5_pct")
    cvr = from_buyers("login_cvr", "user_cvr_pct")
    new_cvr = from_buyers("new_user_cvr", "new_user_cvr_pct")

    def from_temporal(section: str, agg):
        vals = []
        for cid in ids:
            rows = [r for r in temporal.get(section, {}).get("data", []) if str(r.get("company_id")) == cid]
            v = agg(rows)
            if v is not None:
                vals.append((v, nombre(cid)))
        return vals

    varieties = from_temporal(
        "variety_freshness",
        lambda rs: sum(float(r.get("variety_count") or 0) for r in rs) or None,
    )
    anticipation = from_temporal(
        "sell_anticipation",
        lambda rs: (
            sum(float(r.get("avg_days") or 0) * float(r.get("total_gmv") or 0) for r in rs)
            / sum(float(r.get("total_gmv") or 0) for r in rs)
        ) if sum(float(r.get("total_gmv") or 0) for r in rs) > 0 else None,
    )

    defs = [
        ("1_online_sell_pct", "% of sell GMV via online channels (eCommerce + K2K + API)", sell_online),
        ("2_online_buy_pct", "% of buy GMV via online channels (Procurement + K2K + Web)", buy_online),
        ("3_login_cvr", "% of unique eCommerce users who made at least 1 purchase", cvr),
        ("4_new_user_cvr", "% of new eCommerce users who made at least 1 purchase", new_cvr),
        ("5_repeat_rate", "% of online buyers who purchased more than once", repeat),
        ("6_concentration_top5", "% of online GMV from top 5 buyers", conc),
        ("7_variety_count", "Total distinct varieties sold (across all freshness buckets)", varieties),
        ("8_sell_anticipation_avg_days", "GMV-weighted average days between order creation and shipping", anticipation),
    ]
    out = {}
    for key, desc, pares in defs:
        vals = [v for v, _ in pares]
        mejor = max(pares, key=lambda x: x[0]) if pares else (None, None)
        out[key] = {
            "description": f"{desc}, YTD {anchor[:4]} ({ytd_from}..{anchor})",
            "network": {
                "median": pct(vals, 0.50),
                "p75": pct(vals, 0.75),
                "p90": pct(vals, 0.90),
                "best_account": mejor[1],
                "best_value": round(mejor[0], 2) if mejor[0] is not None else None,
                "n": len(vals),
            },
            "by_segment": None,
        }
        print(f"   {key:32} n={len(vals):4}  mediana={out[key]['network']['median']:<8} mejor: {str(mejor[1])[:26]}")

    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_derived.py",
            "cohort": "toda la red presente en los cubos (misma cohorte que la versión anterior)",
            "sources": ["current/sell_monthly.json", "current/buy_monthly.json",
                        "buyers_evidence_v2.json", "temporal_evidence_v2.json"],
            "window": f"{ytd_from}..{anchor}",
        },
        "benchmarks": out,
    }
    dump("benchmarks_v2.json", doc, dry)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cube_sell = load("current/sell_monthly.json")
    cube_buy = load("current/buy_monthly.json")
    accounts = load("accounts_v3.json")["accounts"]
    universe = load("wholesaler_universe.json")

    build_pacing(cube_sell, accounts, args.dry_run)
    print("\nbenchmarks_v2 (percentiles sobre toda la red, misma cohorte que antes):")
    build_benchmarks(cube_sell, cube_buy, accounts, universe,
                     load("buyers_evidence_v2.json"), load("temporal_evidence_v2.json"), args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
