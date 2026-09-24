#!/usr/bin/env python3
"""
Arma `catalog_reach_v1.json`: cuánto del catálogo que una cuenta efectivamente
mueve pasa por un canal online, en las dos direcciones (venta y compra).

QUÉ RESPONDE
------------
"De las categorías / variedades / SKUs que esta cuenta vendió (o compró), ¿cuántas
tocaron alguna vez un canal online?" — y por diferencia, cuántas NUNCA lo tocaron.

POR QUÉ NO SE COPIA EL CÁLCULO DEL DASHBOARD LEGACY
---------------------------------------------------
El v3 calcula el gap como `offline − online`, que es una RESTA DE CONTEOS, no una
diferencia de conjuntos. Los dos conjuntos se solapan casi siempre (de 155 cuentas
que venden por ambos canales, solo 6 son disjuntas), así que un SKU vendido por
los dos lados se cuenta dos veces y se cancela. Resultado en
`skus_online_offline.json`: 141 de 330 cuentas con gap NEGATIVO, 250 de 330
distintas del gap real, y a nivel red 70.062 publicado contra 167.031 real.

Acá el gap es `total − online`, que sí es un conjunto: lo que nunca pasó por
online. Sale directo de COUNT(DISTINCT CASE WHEN canal online THEN x END) contra
COUNT(DISTINCT x), sin restas entre conteos solapados.

CAVEAT DE LA FILA "CATEGORIES"  ← leer antes de comparar entre empresas
------------------------------------------------------------------------
`product_category_name` es texto libre por empresa, no una taxonomía. Medido:
3.997 nombres distintos, 2.739 usados por una sola empresa, y el núcleo lleno
de variantes (Rose / Roses / ROSE / ROSES son cuatro). DENTRO de cada empresa
la grafía es consistente —solo 1 par de 17.432 colapsa al normalizar— así que
el conteo por cuenta es correcto: dice cuántas ETIQUETAS usa.

Lo que queda distorsionado es la comparación contra la mediana de la red: una
empresa que etiqueta fino (Rose Garden / Rose Spray / Rose) parece más ancha
que una que etiqueta grueso (Rosa), con el mismo surtido real.

La taxonomía canónica existe: PRODUCTS.category_network_code_id (1274 = "Rosa"
agrupa todas las variantes de rosa). No es alcanzable desde SALES_SV, hay que
ir por product_id contra PRODUCTS — ver sql/evidence/assortment_gap.sql. Cuando
haya acceso directo, esta fila debería recalcularse sobre el código canónico.

VENTANA FIJA, A PROPÓSITO
-------------------------
Los 12 meses cerrados del cubo (2025-09..2026-08), no el selector de período. La
amplitud de catálogo es una propiedad estructural: una ventana más corta muestra
menos categorías por definición, así que comparar H1 contra YTD mediría el largo
de la ventana, no un cambio de comportamiento. Mostrarlo siguiendo el selector
inventaría una "caída de catálogo" que no existe.

ENTRADA
-------
Dos result sets de Cortex (columns/data), extraídos con las consultas que quedan
en sql/evidence/catalog_reach.sql.

USO
---
    python3 scripts/rebuild_catalog_reach.py --sell sell.json --buy buy.json [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

WINDOW = "2025-09..2026-08"
DIMS = ("categories", "varieties", "skus")
#: Claves válidas para declarar con qué se agruparon las categorías. Es un flag
#: y no una constante a propósito: lo decide quien corre la extracción, y una
#: constante en el código se olvida de editar justo el día que cambia.
CATEGORY_KEYS = ("free_text", "network_code")
#: Catálogos por debajo de esto no dicen nada de cobertura: una finca con 1
#: categoría vendida online da 100% y arrastra la mediana de toda la red.
BENCH_MIN_TOTAL = 10


def pct(values: list[float], q: float):
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return round(xs[0], 1)
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo), 1)


def leer(path: str) -> dict[str, dict]:
    """Result set de Cortex → {company_id: {dim: {total, online, offline_only, coverage_pct}}}."""
    blob = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    cols = [c.lower() for c in blob["columns"]]
    idx = {c: i for i, c in enumerate(cols)}
    out: dict[str, dict] = {}
    for row in blob["data"]:
        cid = str(row[idx["company_id"]]).replace(",", "").strip()
        rec = {}
        for dim, prefix in zip(DIMS, ("cat", "var", "sku")):
            total = int(row[idx[f"{prefix}_total"]])
            online = int(row[idx[f"{prefix}_online"]])
            if online > total:  # imposible: el online es un subconjunto
                raise SystemExit(f"{path}: {cid} tiene {prefix} online {online} > total {total}")
            rec[dim] = {
                "total": total,
                "online": online,
                # conjunto, no resta de conteos: lo que nunca tocó un canal online
                "offline_only": total - online,
                "coverage_pct": round(online / total * 100, 1) if total else None,
            }
        out[cid] = rec
    return out


def benchmarks(lado: dict[str, dict]) -> dict:
    out = {}
    for dim in DIMS:
        vals = [c[dim]["coverage_pct"] for c in lado.values()
                if c[dim]["total"] >= BENCH_MIN_TOTAL and c[dim]["coverage_pct"] is not None]
        out[dim] = {
            "coverage_median": pct(vals, 0.50),
            "coverage_p75": pct(vals, 0.75),
            "coverage_p90": pct(vals, 0.90),
            "n": len(vals),
            "zero_online": sum(1 for v in vals if v == 0),
        }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sell", required=True)
    ap.add_argument("--buy", required=True)
    ap.add_argument("--category-key", choices=CATEGORY_KEYS, default="free_text",
                    help="network_code si la extracción salió de las consultas 3 y 4 "
                         "de catalog_reach.sql (las que hacen el join a PRODUCTS). "
                         "Apaga la advertencia de la tarjeta.")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    sell, buy = leer(a.sell), leer(a.buy)
    companies: dict[str, dict] = {}
    for cid in sorted(set(sell) | set(buy), key=lambda x: int(x) if x.isdigit() else 0):
        companies[cid] = {"sell": sell.get(cid), "buy": buy.get(cid)}

    doc = {
        "_metadata": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generated_by": "scripts/rebuild_catalog_reach.py",
            "query": "sql/evidence/catalog_reach.sql",
            "window": WINDOW,
            "window_note": ("ventana fija de 12 meses cerrados, NO sigue el selector de período: "
                            "la amplitud de catálogo depende del largo de la ventana, así que "
                            "compararla entre períodos de distinto largo mide la ventana, no la cuenta"),
            "sources": {
                "sell": {"view": "PRODUCTION.ANALYTICS.SALES_SV",
                         "online": "sales_channel IN ('eCommerce','K2K','API')",
                         "filters": "ks_flag=TRUE, sales<100000 por línea",
                         "companies": len(sell)},
                "buy": {"view": "PRODUCTION.ANALYTICS.PROCUREMENTS_SV",
                        "online": "sales_channel IN ('Web','Procurement','API')",
                        "offline": "Unknown + N/A",
                        "filters": "ks_flag=TRUE",
                        "companies": len(buy)},
            },
            "gap_definition": ("offline_only = total - online (diferencia de conjuntos). "
                               "NO es offline - online: esos dos conteos se solapan y la resta "
                               "da negativos. Ver hallazgo 10 en hallazgos-validacion-datos"),
            "measures": "lo VENDIDO/COMPRADO por canal, no lo publicado: una variedad listada online sin venta cuenta como no-online",
            "benchmark_min_total": BENCH_MIN_TOTAL,
            # 'free_text'  = agrupado por product_category_name (texto libre por
            #                empresa): el conteo por cuenta vale, la comparación
            #                contra la red está distorsionada.
            # 'network_code' = agrupado por PRODUCTS.category_network_code_id.
            # La tarjeta muestra la advertencia solo mientras diga free_text, así
            # que al regenerar con la versión canónica desaparece sola.
            "category_key": a.category_key,
            "rules_applied": ["R1 ks_flag", "R4 sales<100000 por línea", "R6 online = eCommerce+K2K+API (venta)"],
            "companies": len(companies),
        },
        "network": {"sell": benchmarks(sell), "buy": benchmarks(buy)},
        "companies": companies,
    }

    print(f"empresas: {len(companies)}  (venta {len(sell)} · compra {len(buy)} · ambas {len(set(sell) & set(buy))})")
    for lado in ("sell", "buy"):
        print(f"\n{lado}:")
        for dim in DIMS:
            b = doc["network"][lado][dim]
            print(f"  {dim:11} mediana {str(b['coverage_median']) + '%':>7}  p75 {str(b['coverage_p75']) + '%':>7}"
                  f"  p90 {str(b['coverage_p90']) + '%':>7}  n={b['n']:<4} cero-online={b['zero_online']}")

    if a.dry_run:
        print("\n--dry-run: no se escribió nada")
        return 0
    json.dump(doc, open(DATA / "catalog_reach_v1.json", "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print("\nescrito public/data/catalog_reach_v1.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
