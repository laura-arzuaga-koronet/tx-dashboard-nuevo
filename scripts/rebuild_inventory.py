#!/usr/bin/env python3
"""
Arma `inventory_current_v1.json` desde el resultado de sql/evidence/inventory_current.sql.

Esta es la mitad que sí se puede automatizar: la consulta hay que correrla a mano
en Snowflake porque no existe `INVENTORY_DETAILS_SV` y el MCP de Cortex solo
ejecuta contra vistas semánticas. Una vez que el resultado está acá, esto lo
convierte en el JSON con la forma exacta que espera el adapter.

ENTRADA
-------
CSV o JSON exportado de Snowflake con estas columnas (las devuelve la consulta):

    GROUPING, COMPANY_ID, COMPANY_NAME, BUCKET, CODE,
    ITEM_COUNT, UNIQUE_PRODUCTS, UNIQUE_CATEGORIES, UNIQUE_VARIETIES, TOTAL_UNITS

`GROUPING` vale 'by_inventory_type' o 'by_inventory_division' y separa las dos
mitades del archivo.

OJO CON EL FORMATO: la exportación del worksheet manda los números como texto con
separador de miles ("1,241", "6,801,539"), COMPANY_ID incluido. Todo pasa por
num()/cid() para normalizarlo; si no, el company_id queda como string con coma y
el adapter no encuentra la fila.

Los conteos ÚNICOS de red (products/categories/varieties) no se pueden sumar desde
este archivo: necesitan dedup cruzada entre empresas y entre tipos. Salen de la
segunda consulta del .sql, que se pasa con --totales. Sin ella quedan en null con
su nota, en vez de arrastrar los valores viejos haciéndolos pasar por nuevos.

USO
---
    python3 scripts/rebuild_inventory.py --csv ~/Downloads/inventory.json \
        [--totales ~/Downloads/inventory_totals.csv] [--dry-run]
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

REQUERIDAS = {"GROUPING", "COMPANY_ID", "BUCKET", "ITEM_COUNT", "TOTAL_UNITS"}


def num(v):
    """'6,801,539' → 6801539. Vacío o basura → 0."""
    if v is None or str(v).strip() == "":
        return 0
    try:
        f = float(str(v).replace(",", "").replace("$", "").strip())
        return int(f) if f.is_integer() else f
    except ValueError:
        return 0


def cid(v) -> str:
    """El company_id también viene con separador de miles: '1,241' → '1241'."""
    return str(v).replace(",", "").strip()


def leer(path: str) -> list[dict]:
    """Acepta JSON (lista de objetos, o {columns, data}) y CSV indistintamente."""
    texto = pathlib.Path(path).read_text(encoding="utf-8-sig")
    cabeza = texto.lstrip()[:1]
    if cabeza in "[{":
        blob = json.loads(texto)
        if isinstance(blob, dict) and "columns" in blob and "data" in blob:
            cols = [c.upper() if isinstance(c, str) else c["name"].upper() for c in blob["columns"]]
            filas = [dict(zip(cols, row)) for row in blob["data"]]
        else:
            filas = [{k.strip().upper(): v for k, v in r.items()} for r in blob]
        return filas
    try:
        dial = csv.Sniffer().sniff(texto[:4096], delimiters=",;\t")
    except csv.Error:
        dial = csv.excel
    return [{k.strip().upper(): v for k, v in r.items()}
            for r in csv.DictReader(texto.splitlines(), dialect=dial)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="resultado de la consulta principal (CSV o JSON)")
    ap.add_argument("--totales", help="resultado de la consulta de totales de red (opcional)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    filas = leer(a.csv)
    if not filas:
        print("el archivo está vacío", file=sys.stderr)
        return 1
    faltan = REQUERIDAS - set(filas[0])
    if faltan:
        print(f"faltan columnas: {sorted(faltan)}\ntiene: {sorted(filas[0])}", file=sys.stderr)
        return 1

    prev = json.load(open(DATA / "inventory_current_v1.json", encoding="utf-8"))

    companies: dict[str, dict] = {}
    for r in filas:
        k = cid(r["COMPANY_ID"])
        c = companies.setdefault(k, {
            "company_id": int(k) if k.isdigit() else k,
            "company_name": (r.get("COMPANY_NAME") or "").strip() or None,
            "by_inventory_type": {},
            "by_inventory_division": {},
        })
        bloque = {
            "item_count": num(r["ITEM_COUNT"]),
            "unique_products": num(r.get("UNIQUE_PRODUCTS")),
            "unique_categories": num(r.get("UNIQUE_CATEGORIES")),
            "unique_varieties": num(r.get("UNIQUE_VARIETIES")),
            "total_units": num(r["TOTAL_UNITS"]),
        }
        bucket = (r["BUCKET"] or "").strip()
        if r["GROUPING"] == "by_inventory_type":
            # el JSON guarda el código junto al bloque; '(blank)' es el on-hand
            c["by_inventory_type"][bucket] = {
                "inventory_type_code": (r.get("CODE") or "").strip() or "(blank)", **bloque}
        else:
            c["by_inventory_division"][bucket] = bloque

    # totales por empresa: se suman los TIPOS (no las divisiones, para no contar
    # dos veces el mismo ítem). Los conteos únicos NO se suman: requieren dedup.
    for c in companies.values():
        tipos = c["by_inventory_type"].values()
        c["totals"] = {
            "total_items": sum(t["item_count"] for t in tipos),
            "total_units": sum(t["total_units"] for t in tipos),
            "note": ("unique_products/categories/varieties across types require cross-type dedup; "
                     "see network_summary for network-level deduped counts"),
        }

    # ── control de integridad: los dos cortes tienen que cuadrar ítem por ítem ──
    por_tipo_items = sum(num(r["ITEM_COUNT"]) for r in filas if r["GROUPING"] == "by_inventory_type")
    por_div_items = sum(num(r["ITEM_COUNT"]) for r in filas if r["GROUPING"] == "by_inventory_division")
    if por_tipo_items != por_div_items:
        print(f"⚠ los dos cortes no cuadran: tipo={por_tipo_items:,} división={por_div_items:,}. "
              "Suele ser truncado en la descarga del worksheet.", file=sys.stderr)
    sin_tipo = [k for k, c in companies.items() if not c["by_inventory_type"]]
    sin_div = [k for k, c in companies.items() if not c["by_inventory_division"]]
    if sin_tipo or sin_div:
        print(f"⚠ empresas sin uno de los cortes: sin tipo={len(sin_tipo)} sin división={len(sin_div)}")

    # ── network_summary ─────────────────────────────────────────────────────────
    por_tipo: dict[str, dict] = {}
    for r in filas:
        if r["GROUPING"] != "by_inventory_type":
            continue
        b = por_tipo.setdefault((r["BUCKET"] or "").strip(), {
            "inventory_type_code": (r.get("CODE") or "").strip() or "(blank)",
            "total_items": 0, "companies": 0, "total_units": 0})
        b["total_items"] += num(r["ITEM_COUNT"])
        b["companies"] += 1
        b["total_units"] += num(r["TOTAL_UNITS"])

    network = {
        "totals": {
            "total_items": por_tipo_items,
            "total_companies": len(companies),
            "total_units": sum(b["total_units"] for b in por_tipo.values()),
        },
        "by_inventory_type": por_tipo,
    }
    if a.totales:
        t = leer(a.totales)[0]
        network["totals"].update({
            "total_unique_products": num(t.get("TOTAL_UNIQUE_PRODUCTS")),
            "total_unique_categories": num(t.get("TOTAL_UNIQUE_CATEGORIES")),
            "total_unique_varieties": num(t.get("TOTAL_UNIQUE_VARIETIES")),
        })
    else:
        # null explícito, no el valor viejo: arrastrarlo lo haría pasar por nuevo.
        network["totals"].update({
            "total_unique_products": None,
            "total_unique_categories": None,
            "total_unique_varieties": None,
        })
        network["note"] = ("unique_* pendientes: requieren la consulta de totales de red "
                           "(dedup cruzada entre empresas). Referencia 2026-08-06: "
                           "products 174970 / categories 2995 / varieties 49763")
        print("⚠ sin --totales: los conteos únicos de red quedan en null")

    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_inventory.py",
            "query": "sql/evidence/inventory_current.sql (corrida a mano en Snowflake)",
            "source_table": "PRODUCTION.ANALYTICS.INVENTORY_DETAILS",
            "filters": {"ks_flag": True, "total_units": "> 0"},
            "label": "proxy -- INVENTORY_DETAILS with TOTAL_UNITS > 0. Not confirmed eShop visibility.",
            "caveats": prev.get("_metadata", {}).get("caveats"),
            "data_rules_applied": prev.get("_metadata", {}).get("data_rules_applied"),
            "previous_file_generated_at": prev.get("_metadata", {}).get("generated_at"),
            "companies": len(companies),
        },
        "network_summary": network,
        "companies": companies,
    }

    ant = prev.get("network_summary", {}).get("totals", {})
    print(f"empresas: {len(companies)}  (antes {len(prev.get('companies', {}))})")
    print(f"tipos: {sorted({b for c in companies.values() for b in c['by_inventory_type']})}")
    print(f"divisiones: {sorted({b for c in companies.values() for b in c['by_inventory_division']})}")
    print(f"ítems: {por_tipo_items:,}  (antes {ant.get('total_items', 0):,})")
    print(f"unidades: {network['totals']['total_units']:,}  (antes {ant.get('total_units', 0):,})")

    if a.dry_run:
        print("--dry-run: no se escribió nada")
        return 0
    json.dump(doc, open(DATA / "inventory_current_v1.json", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print("escrito public/data/inventory_current_v1.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
