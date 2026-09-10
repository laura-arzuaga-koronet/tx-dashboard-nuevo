#!/usr/bin/env python3
"""
Reconstruye `hardgoods_v2.json` desde SALES_SV.

El archivo anterior era del 2026-08-05 (34 días). Se rearma la parte de HARD
GOODS con ventas por empresa × división × canal, ene–ago 2026.

LO QUE NO SE PUDO REFRESCAR
---------------------------
`inventory_division` en Snowflake solo toma tres valores: Boxes, Units y
Hard Goods. NO existe "Plants", que el archivo anterior reportaba como una
división aparte — debe salir de otro campo (categoría o división de producto)
que no está expuesto en el modelo semántico disponible. Los bloques de plants se
preservan del archivo anterior y quedan marcados en `_metadata.not_refreshed`
para que nadie los lea como frescos.

USO
---
    python3 scripts/rebuild_hardgoods.py --sales /tmp/hardgoods_raw.json [--dry-run]
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

    por_empresa: dict[str, dict] = collections.defaultdict(
        lambda: {"hardgoods_online": 0.0, "hardgoods_offline": 0.0})
    nombres: dict[str, str] = {}
    for r in blob["data"]:
        if r[i["INVENTORY_DIVISION"]] != "Hard Goods":
            continue
        cid = str(r[i["COMPANY_ID"]])
        nombres[cid] = r[i["COMPANY_NAME"]]
        key = "hardgoods_online" if r[i["SALES_CHANNEL"]] in ONLINE else "hardgoods_offline"
        por_empresa[cid][key] += float(r[i["TOTAL_SALES"]] or 0)

    prev = json.load(open(DATA / "hardgoods_v2.json", encoding="utf-8"))
    prev_by_name = {c.get("company_name"): c for c in prev.get("companies", [])}

    companies = []
    for cid, v in por_empresa.items():
        nombre = nombres[cid]
        antes = prev_by_name.get(nombre, {})
        total = v["hardgoods_online"] + v["hardgoods_offline"]
        companies.append({
            "company_name": nombre,
            "company_id": cid,
            "ct_id": antes.get("ct_id"),
            "hardgoods_total": round(total, 2),
            "hardgoods_online": round(v["hardgoods_online"], 2),
            "hardgoods_offline": round(v["hardgoods_offline"], 2),
            "hardgoods_online_pct": round(v["hardgoods_online"] / total * 100, 2) if total else 0.0,
            # plants: sin origen en inventory_division, se preserva
            "plants_total": antes.get("plants_total"),
            "plants_online": antes.get("plants_online"),
            "plants_offline": antes.get("plants_offline"),
            "plants_online_pct": antes.get("plants_online_pct"),
        })
    companies.sort(key=lambda c: -(c["hardgoods_total"] or 0))

    on = sum(c["hardgoods_online"] for c in companies)
    off = sum(c["hardgoods_offline"] for c in companies)
    tot = on + off
    net = {
        "hardgoods_online": round(on, 2), "hardgoods_offline": round(off, 2),
        "hardgoods_total": round(tot, 2),
        "hardgoods_online_pct": round(on / tot * 100, 2) if tot else 0.0,
        "plants_online": prev.get("network_totals", {}).get("plants_online"),
        "plants_offline": prev.get("network_totals", {}).get("plants_offline"),
        "plants_total": prev.get("network_totals", {}).get("plants_total"),
        "plants_online_pct": prev.get("network_totals", {}).get("plants_online_pct"),
    }
    pcts = sorted(c["hardgoods_online_pct"] for c in companies)
    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_hardgoods.py",
            "source": "PRODUCTION.ANALYTICS.SALES_SV",
            "filters": f"ks_flag=TRUE, sales<100000 (por línea), shipping_date in {WINDOW}",
            "period": WINDOW,
            "rules_applied": ["R1 ks_flag", "R4 sales<100000", "R6 online = eCommerce+K2K+API"],
            "not_refreshed": {
                "fields": ["plants_total", "plants_online", "plants_offline", "plants_online_pct"],
                "reason": ("inventory_division en Snowflake solo toma Boxes, Units y Hard Goods: "
                           "no existe 'Plants'. Sale de otro campo no expuesto en el modelo semántico."),
                "previous_file_generated": prev.get("_metadata", {}).get("generated"),
            },
            "companies": len(companies),
        },
        "network_totals": net,
        "hardgoods_online_pct_benchmark": {
            "median": pcts[len(pcts) // 2] if pcts else None,
            "n": len(pcts),
        },
        "plants_online_pct_benchmark": prev.get("plants_online_pct_benchmark"),
        "companies": companies,
    }
    print(f"empresas con hard goods: {len(companies)} (antes {len(prev.get('companies', []))})")
    print(f"red: online ${on:,.0f} / total ${tot:,.0f} = {net['hardgoods_online_pct']}%  (antes 0.14%)")
    if a.dry_run:
        print("--dry-run: no se escribió nada"); return 0
    json.dump(doc, open(DATA / "hardgoods_v2.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("escrito public/data/hardgoods_v2.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
