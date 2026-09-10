#!/usr/bin/env python3
"""
Reconstruye `config_evidence_v2.json` desde tres extracciones de Snowflake.

El archivo anterior era del 2026-07-31 (40 días). Se rearma con:

  COMPANIES         → fees por canal, eshops, is_procurement_active, industria
  COMPANY_SETTINGS  → maxAge, future sales, unidades, K2K, días de anticipación
  SALES_SV          → bunches_reality: quién vende bunches por eCommerce de verdad

UN HALLAZGO DEL CAMINO
----------------------
El `_meta` viejo decía que la config salía de `COMPANIES_SV`, pero las tarifas
(ecommerce_fee, k2k_fee, api_fee y sus montos) viven en `COMPANIES`, mientras que
maxAge y las banderas de future sales viven en `COMPANY_SETTINGS` como pares
nombre/valor con nombres en camelCase — no en snake_case como los guarda el JSON.
Por eso el primer pivot devolvió todo vacío. El mapeo quedó explícito en
FIELD_MAP para que la próxima vez no haya que redescubrirlo.

`sell_in_bunches` y `max_age_sell` no existen como settings en Snowflake: los
consume ListCard pero no tienen origen conocido, así que se preservan del archivo
anterior y quedan listados en `_metadata.not_refreshed`.

La ventana de bunches_reality ahora llega hasta agosto (antes cortaba en julio),
para alinearla con el cierre de los cubos.

USO
---
    python3 scripts/rebuild_config_evidence.py \
        --companies /tmp/companies_config.json \
        --settings  /tmp/company_settings.json \
        [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

#: campo del JSON → columna de la extracción (mayúsculas como las devuelve Snowflake)
FIELD_MAP_COMPANIES = {
    "ecommerce_fee": "ECOMMERCE_FEE",
    "ecommerce_fee_amount": "ECOMMERCE_FEE_AMOUNT",
    "k2k_fee": "K2K_FEE",
    "k2k_fee_amount": "K2K_FEE_AMOUNT",
    "api_fee": "API_FEE",
    "api_fee_amount": "API_FEE_AMOUNT",
    "api_fee_percentage": "API_FEE_PERCENTAGE",
    "eshops": "ESHOPS",
    "is_procurement_active": "IS_PROCUREMENT_ACTIVE",
}
FIELD_MAP_SETTINGS = {
    "ecommerce_max_age": "ECOMMERCEMAXAGE",
    "ecommerce_future_sales_enabled": "ECOMMERCEALLOWFUTURESALES",
    "future_sales_enabled": "FUTURESALESENABLED",
    "is_on_hand_inventory_units": "ECOMMERCEENABLESALESONHANDINVENTORYUNITS",
    "is_ecommerce_future_sales_units": "ECOMMERCEALLOWFUTURESALESUNITS",
    "ecommerce_days_in_advance": "ECOMMERCEDAYSINADVANCE",
    "k2k_ecommerce": "K2KINTEGRATIONENABLE",
    "k2k_future_sales_inventory_enabled": "K2KFUTURESALESINVENTORYENABLED",
    "ecommerce_enabled": "ECOMMERCEENABLED",
    "ecommerce_sells_bunches_config": "ECOMMERCEENABLESALESPRODUCTBUNCHES",
    "ecommerce_cap": "ECOMMERCECAP",
    "ecommerce_cap_bunches": "ECOMMERCECAPBUNCHES",
    "min_age": "MINAGE",
    "prebook_days_in_advance": "PREBOOKDAYSINADVANCE",
    "go_live_date": "GOLIVEDATE",
    "hardgood_enabled": "HARDGOODENABLED",
}
#: consumidos por la UI pero sin origen conocido en Snowflake: se preservan.
NOT_REFRESHED = ["sell_in_bunches", "max_age_sell"]

#: bunches_reality — companies con venta real de unidades por eCommerce (ene–ago 2026)
BUNCHES_REALITY = {
    "7030": 71491, "44150": 14643, "743648": 13812, "641341": 13033, "496600": 2750,
    "592345": 1317, "498865": 1184, "601933": 1041, "672781": 930, "474847": 827,
    "816515": 697, "394783": 223, "664096": 119, "649585": 21, "571220": 10,
    "808079": 6, "828336": 3, "624737": 2, "742939": 1, "1241": 1,
}
BUNCHES_WINDOW = "2026-01-01..2026-08-31"


def coerce(v):
    """'true'/'false' → bool, numérico → número, '' → None, resto tal cual."""
    if v is None or v == "":
        return None
    s = str(v).strip()
    if s.lower() in ("true", "1"):
        return True
    if s.lower() in ("false", "0"):
        return False
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return s


def rows_by_id(path: str) -> dict[str, dict]:
    with open(path, encoding="utf-8") as fh:
        blob = json.load(fh)
    cols = blob["columns"]
    out = {}
    for row in blob["data"]:
        rec = dict(zip(cols, row))
        out[str(rec["COMPANY_ID"])] = rec
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--companies", required=True)
    ap.add_argument("--settings", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    comp = rows_by_id(args.companies)
    sett = rows_by_id(args.settings)
    with open(DATA / "config_evidence_v2.json", encoding="utf-8") as fh:
        prev = json.load(fh)
    # `companies` está indexado por company_id: así lo consume
    # store.config[companyId] en el adapter. Indexarlo por nombre dejaba las
    # 4.014 cuentas sin fila de config.
    prev_by_id = {str(k): v for k, v in prev.get("companies", {}).items()}

    ids = set(comp) | set(sett)
    companies: dict[str, dict] = {}
    preservados = 0
    for cid in sorted(ids):
        c, s = comp.get(cid, {}), sett.get(cid, {})
        nombre = c.get("COMPANY_NAME") or s.get("COMPANY_NAME") or cid
        antes = prev_by_id.get(cid, {})
        cfg_antes = antes.get("config") or {}

        cfg = {}
        for k, col in FIELD_MAP_SETTINGS.items():
            cfg[k] = coerce(s.get(col))
        for k, col in FIELD_MAP_COMPANIES.items():
            cfg[k] = coerce(c.get(col))
        for k in NOT_REFRESHED:
            if k in cfg_antes:
                cfg[k] = cfg_antes[k]
                preservados += 1

        n = BUNCHES_REALITY.get(cid)
        companies[cid] = {
            "company_id": cid,
            "company_name": nombre,
            "company_industry": c.get("COMPANY_INDUSTRY") or antes.get("company_industry"),
            "config": cfg,
            "bunches_reality": {
                "actually_sells_bunches_ecom": n is not None,
                "distinct_sale_items": n or 0,
                "window": BUNCHES_WINDOW,
            },
            # SFDC llega por su propio archivo (sfdc_open_opportunities_v1.json);
            # se preserva lo que hubiera para no perderlo en la reconstrucción.
            "sfdc": antes.get("sfdc"),
        }

    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_config_evidence.py",
            "sources": {
                "config_fees": {"table": "PRODUCTION.ANALYTICS.COMPANIES", "filters": "ks_flag=TRUE",
                                "rows": len(comp), "fields": sorted(FIELD_MAP_COMPANIES)},
                "config_settings": {"table": "PRODUCTION.ANALYTICS.COMPANY_SETTINGS", "filters": "ks_flag=TRUE",
                                    "rows": len(sett), "fields": sorted(FIELD_MAP_SETTINGS),
                                    "note": "pares nombre/valor; los nombres son camelCase, no snake_case"},
                "bunches_reality": {"view": "PRODUCTION.ANALYTICS.SALES_SV",
                                    "filters": ("inventory_division='Units' AND sales_channel='eCommerce' "
                                                "AND ks_flag=TRUE AND sales<100000 AND "
                                                f"shipping_date in {BUNCHES_WINDOW}"),
                                    "dedup": "COUNT(DISTINCT sale_item_id) (R5+R16)",
                                    "companies_with_sales": len(BUNCHES_REALITY)},
            },
            "not_refreshed": {
                "fields": NOT_REFRESHED,
                "reason": "ListCard los consulta pero no existen ni en Snowflake ni en el archivo anterior: la tarjeta ya caia en su fallback",
                "preserved_values": preservados,
                "previous_file_generated": prev.get("_metadata", {}).get("generated"),
            },
            "rules_applied": ["R1 ks_flag", "R4 sales<100000", "R5/R16 dedup sale_item_id"],
            "companies": len(companies),
        },
        "companies": companies,
    }

    print(f"empresas: {len(companies)}  (antes {len(prev.get('companies', {}))})")
    print(f"con venta real de bunches por eCommerce: {len(BUNCHES_REALITY)}")
    print(f"valores preservados de campos sin origen: {preservados}")
    faltan_fees = sum(1 for r in companies.values() if r["config"]["ecommerce_fee"] is None)
    print(f"sin dato de ecommerce_fee: {faltan_fees}")

    if args.dry_run:
        print("--dry-run: no se escribió nada")
        return 0
    with open(DATA / "config_evidence_v2.json", "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    print("escrito public/data/config_evidence_v2.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
