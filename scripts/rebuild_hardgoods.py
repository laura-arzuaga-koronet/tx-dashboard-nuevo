#!/usr/bin/env python3
"""
Reconstruye `hardgoods_v2.json` desde SALES_SV.

El archivo anterior era del 2026-08-05 (34 días). Se rearma la parte de HARD
GOODS con ventas por empresa × división × canal, ene–ago 2026.

DE DÓNDE SALE CADA DIVISIÓN
---------------------------
Al principio busqué hard goods y plants en `inventory_division`, que solo toma
Boxes / Units / Hard Goods — y ahí no hay plants. La división correcta es
`product_category_division_name`, que toma Fresh Cut / Hard Goods / Plants. Con
esa dimensión salen las dos mitades del archivo de una sola consulta.

USO
---
    python3 scripts/rebuild_hardgoods.py --sales /tmp/hardgoods_div.json [--dry-run]
"""
from __future__ import annotations
import argparse, collections, json, pathlib, sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"
ONLINE = {"eCommerce", "K2K", "API"}
WINDOW = "2026-01-01..2026-08-31"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sales", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    blob = json.load(open(a.sales, encoding="utf-8"))
    cols = blob["columns"]
    i = {c: cols.index(c) for c in cols}

    DIV = {"Hard Goods": "hardgoods", "Plants": "plants"}
    por_empresa: dict[str, dict] = collections.defaultdict(lambda: {
        "hardgoods_online": 0.0, "hardgoods_offline": 0.0,
        "plants_online": 0.0, "plants_offline": 0.0})
    nombres: dict[str, str] = {}
    for r in blob["data"]:
        pref = DIV.get(r[i["PRODUCT_CATEGORY_DIVISION_NAME"]])
        if not pref:            # Fresh Cut y el valor vacío no van a este archivo
            continue
        cid = str(r[i["COMPANY_ID"]])
        nombres[cid] = r[i["COMPANY_NAME"]]
        canal = "online" if r[i["SALES_CHANNEL"]] in ONLINE else "offline"
        por_empresa[cid][f"{pref}_{canal}"] += float(r[i["TOTAL_SALES"]] or 0)

    prev = json.load(open(DATA / "hardgoods_v2.json", encoding="utf-8"))
    prev_by_name = {c.get("company_name"): c for c in prev.get("companies", [])}

    companies = []
    for cid, v in por_empresa.items():
        nombre = nombres[cid]
        antes = prev_by_name.get(nombre, {})
        fila = {"company_name": nombre, "company_id": cid, "ct_id": antes.get("ct_id")}
        for pref in ("hardgoods", "plants"):
            on, off = v[f"{pref}_online"], v[f"{pref}_offline"]
            tot = on + off
            fila[f"{pref}_total"] = round(tot, 2)
            fila[f"{pref}_online"] = round(on, 2)
            fila[f"{pref}_offline"] = round(off, 2)
            fila[f"{pref}_online_pct"] = round(on / tot * 100, 2) if tot else 0.0
        companies.append(fila)
    companies.sort(key=lambda c: -((c["hardgoods_total"] or 0) + (c["plants_total"] or 0)))

    net = {}
    for pref in ("hardgoods", "plants"):
        on = sum(c[f"{pref}_online"] for c in companies)
        off = sum(c[f"{pref}_offline"] for c in companies)
        tot = on + off
        net[f"{pref}_online"] = round(on, 2)
        net[f"{pref}_offline"] = round(off, 2)
        net[f"{pref}_total"] = round(tot, 2)
        net[f"{pref}_online_pct"] = round(on / tot * 100, 2) if tot else 0.0
    bench = {}
    for pref in ("hardgoods", "plants"):
        pcts = sorted(c[f"{pref}_online_pct"] for c in companies if c[f"{pref}_total"])
        bench[pref] = {"median": pcts[len(pcts) // 2] if pcts else None, "n": len(pcts)}
    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_hardgoods.py",
            "source": "PRODUCTION.ANALYTICS.SALES_SV",
            "filters": f"ks_flag=TRUE, sales<100000 (por línea), shipping_date in {WINDOW}",
            "period": WINDOW,
            "rules_applied": ["R1 ks_flag", "R4 sales<100000", "R6 online = eCommerce+K2K+API"],
            "division_source": ("product_category_division_name (Fresh Cut / Hard Goods / Plants). "
                                "NO inventory_division, que solo toma Boxes / Units / Hard Goods "
                                "y no tiene plants."),
            "previous_file_generated": prev.get("_metadata", {}).get("generated"),
            "companies": len(companies),
        },
        "network_totals": net,
        "hardgoods_online_pct_benchmark": bench["hardgoods"],
        "plants_online_pct_benchmark": bench["plants"],
        "companies": companies,
    }
    print(f"empresas: {len(companies)} (antes {len(prev.get('companies', []))})")
    for pref in ("hardgoods", "plants"):
        print(f"   {pref:10} total ${net[f'{pref}_total']:>14,.0f}  online {net[f'{pref}_online_pct']}%"
              f"  ·  {bench[pref]['n']} empresas")
    if a.dry_run:
        print("--dry-run: no se escribió nada"); return 0
    json.dump(doc, open(DATA / "hardgoods_v2.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("escrito public/data/hardgoods_v2.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
