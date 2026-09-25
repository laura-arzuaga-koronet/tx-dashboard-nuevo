#!/usr/bin/env python3
"""
Alinea accounts_v3.json con el universo de companies de Snowflake.

POR QUÉ EXISTE
--------------
accounts_v3 nació del cruce STG_SALESFORCE_ACCOUNT + COMPANIES, y ese cruce se
rompía en silencio en algunas cuentas. Tennessee Florist Supply - Knox (650986)
es el caso que lo destapó: está live en Snowflake, en Salesforce es un Customer,
y aun así venía con sfdc_id vacío y account_class = 'Prospect'. Por eso no
aparecía en el tab de clientes. Lo mismo pasaba con otras 23 cuentas: su
komet_status y su clase se habían congelado en la foto del backfill.

REGLA (decisión de Laura, 2026-09-25)
-------------------------------------
Toda company del modelo COMPANIES (ks_flag = TRUE) está en el dashboard, y su
clase se deriva del propio modelo, no del cruce con Salesforce:

    komet_status = 'Production - Live' y record_type_name = 'Customer' → Client
    komet_status empieza con 'Implementation'                         → Pre-live
    cualquier otro caso                                               → Prospect

Los prospects de Salesforce sin company en Koronet siguen como estaban: esto
solo toca las filas que tienen company en Snowflake.

QUÉ HACE, EN ORDEN
------------------
1. Enlaza cada company con su fila de accounts_v3: primero por company_id y, si
   no la encuentra, por sfdc_id (hay filas de SFDC sin company_id). Si no existe
   ninguna, agrega una fila nueva.
2. Completa el sfdc_id faltante con el account_id de COMPANIES y refresca
   komet_status, record_type e industry, que en accounts_v3 estaban viejos.
3. Recalcula account_class con la regla de arriba. El segment solo se toca
   cuando la clase cambia, para que siga siendo coherente con ella.
4. Est GMV de último recurso: si la cuenta no tiene ninguna otra fuente, o solo
   tiene el viejo 'Estimado (AnnualRevenue×0.11)', usa el Annual Total Sales
   × ATS_FACTOR con la fuente 'Annual Total Sales'. La cascada completa queda:

       Medido → Piso de red → Estimado (framework) → ORA → Annual Total Sales

   El ×0,11 se reemplaza porque se había identificado como error: dejaba el Est
   GMV ~9 veces por debajo, y el ORA lo corrobora (ratio 0,07 donde coexisten).
   Si el equipo decide volver al factor, basta con cambiar ATS_FACTOR.

Para las filas nuevas, correr después rebuild_accounts_gmv.py: es el que mide la
venta del cubo y aplica Medido / Piso de red.

USO
---
    python3 scripts/rebuild_companies_universe.py            # escribe
    python3 scripts/rebuild_companies_universe.py --dry-run  # solo reporta
    # desde la extracción de extract_snowflake.py: primero refresca la foto
    python3 scripts/rebuild_companies_universe.py --staging /tmp/staging/companies_universe.json
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"

#: Est GMV = Annual Total Sales × este factor, solo como último recurso.
ATS_FACTOR = 1.0
ATS_SOURCE = "Annual Total Sales"
OLD_ATS_SOURCE = "Estimado (AnnualRevenue×0.11)"
BUY_TO_SELL_RATIO = 0.45

INDUSTRY_TO_BT = {
    "Floral - Wholesaler": "Wholesaler",
    "Floral - Wholesalers": "Wholesaler",
    "Floral - Importer": "Importer",
    "Floral - Grower": "Grower",
    "Floral - Retailer": "Retailer",
    "Floral - Broker": "Broker",
}


def derive_class(komet_status: str | None, record_type: str | None) -> str:
    ks = (komet_status or "").strip()
    if ks == "Production - Live" and record_type == "Customer":
        return "Client"
    if ks.startswith("Implementation"):
        return "Pre-live"
    return "Prospect"


def segment_for(new_class: str, komet_status: str | None, record_type: str | None, prev: str | None) -> str | None:
    if new_class == "Client":
        return "Activo"
    if new_class == "Pre-live":
        return "Onboarding"
    if (komet_status or "").endswith("Deactivated") or record_type == "Churned Customer":
        return "Churned"
    return prev if prev not in ("Activo", "Onboarding") else "Otro (Komet)"


def has_gmv(a: dict) -> bool:
    try:
        return float(a.get("gmv_reference") or 0) > 0
    except (TypeError, ValueError):
        return False


def blank_row(template: dict) -> dict:
    """Fila vacía con el mismo esquema que el resto de accounts_v3."""
    row: dict = {}
    for k, v in template.items():
        row[k] = False if isinstance(v, bool) else (0 if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
    row.update({"gmv_reference": "", "gmv_source": "", "product_tier": "Unknown", "potential_tier": "Unmeasured"})
    return row


def num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def refresh_snapshot(staging: pathlib.Path) -> None:
    """Reescribe companies_universe_v1.json desde la salida de extract_snowflake.py."""
    raw = json.loads(staging.read_text(encoding="utf-8"))
    cols = [c.lower() for c in raw["columns"]]
    rows = [dict(zip(cols, r)) for r in raw["data"]]
    companies = [{
        "company_id": str(r["company_id"]),
        "sfdc_id": r.get("account_id") or None,
        "company_name": r.get("company_name"),
        "company_industry": r.get("company_industry") or None,
        "komet_status": r.get("komet_status") or None,
        "record_type_name": r.get("record_type_name") or None,
        "komet_account_type": r.get("komet_account_type") or None,
        "annual_total_sales": num(r.get("annual_total_sales")),
    } for r in rows]
    meta = {
        "generated_at": raw.get("_extract", {}).get("at"),
        "source": "PRODUCTION.ANALYTICS.COMPANIES (ks_flag = TRUE)",
        "query": "sql/evidence/companies_universe.sql",
        "snowflake_query_id": raw.get("_extract", {}).get("query_id"),
        "rows": len(companies),
    }
    (DATA / "companies_universe_v1.json").write_text(
        json.dumps({"_metadata": meta, "companies": companies}, ensure_ascii=False, indent=0), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--staging", type=pathlib.Path, help="companies_universe.json de extract_snowflake.py")
    args = ap.parse_args()
    if args.staging:
        refresh_snapshot(args.staging)

    companies = json.loads((DATA / "companies_universe_v1.json").read_text(encoding="utf-8"))["companies"]
    doc = json.loads((DATA / "accounts_v3.json").read_text(encoding="utf-8"))
    accounts: list[dict] = doc["accounts"]

    by_cid = {str(a["company_id"]): a for a in accounts if a.get("company_id")}
    by_sfdc = {a["sfdc_id"]: a for a in accounts if a.get("sfdc_id") and not a.get("company_id")}
    sfdc_taken = {a["sfdc_id"] for a in accounts if a.get("sfdc_id")}

    log = collections.Counter()
    movidas: list[tuple] = []
    template = accounts[0]

    for c in companies:
        cid, sfdc = c["company_id"], c.get("sfdc_id")
        # ks_flag deja pasar al menos una cuenta de prueba de Komet
        if "test account" in (c.get("company_name") or "").lower():
            log["omitida: cuenta de prueba"] += 1
            continue
        a = by_cid.get(cid)
        if a is None and sfdc and sfdc in by_sfdc:
            a = by_sfdc.pop(sfdc)
            a["company_id"] = cid
            by_cid[cid] = a
            log["enlazada por sfdc_id (fila SFDC sin company_id)"] += 1
        if a is None:
            a = blank_row(template)
            a.update({
                "company_id": cid,
                "company_name": c["company_name"],
                "sfdc_id": sfdc if sfdc not in sfdc_taken else None,
                "business_type": INDUSTRY_TO_BT.get(c.get("company_industry") or "", "Otro"),
            })
            accounts.append(a)
            by_cid[cid] = a
            log["fila nueva"] += 1
            movidas.append((c["company_name"], "(no estaba)", derive_class(c["komet_status"], c["record_type_name"])))

        if not a.get("sfdc_id") and sfdc and sfdc not in sfdc_taken:
            a["sfdc_id"] = sfdc
            sfdc_taken.add(sfdc)
            log["sfdc_id completado"] += 1

        a["komet_status"] = c.get("komet_status")
        a["record_type"] = c.get("record_type_name")
        if c.get("company_industry"):
            a["industry"] = c["company_industry"]

        prev_class = a.get("account_class")
        new_class = derive_class(c.get("komet_status"), c.get("record_type_name"))
        if prev_class != new_class:
            if prev_class is not None:
                movidas.append((a.get("company_name"), prev_class, new_class))
                log[f"clase {prev_class} → {new_class}"] += 1
            a["account_class"] = new_class
            a["segment"] = segment_for(new_class, c.get("komet_status"), c.get("record_type_name"), a.get("segment"))

        ats = c.get("annual_total_sales")
        if ats and ats > 0:
            a["annual_revenue"] = ats
            if not has_gmv(a) or a.get("gmv_source") == OLD_ATS_SOURCE:
                log[f"Est GMV ← Annual Total Sales ({'reemplaza ×0,11' if a.get('gmv_source') == OLD_ATS_SOURCE else 'sin otra fuente'})"] += 1
                a["gmv_reference"] = round(ats * ATS_FACTOR, 2)
                a["gmv_source"] = ATS_SOURCE
                a["gmv_is_floor"] = False
                a["buy_gmv_estimated"] = round(ats * ATS_FACTOR * BUY_TO_SELL_RATIO, 2)

    # Filas de SFDC que conservan el ×0,11 sin company en Snowflake: mismo dato
    # (Annual_Total_Sales__c, ya está en annual_revenue), misma regla.
    for a in accounts:
        if a.get("gmv_source") == OLD_ATS_SOURCE:
            ats = float(a.get("annual_revenue") or 0)
            if ats > 0:
                log["Est GMV ← Annual Total Sales (reemplaza ×0,11, sin company)"] += 1
                a["gmv_reference"] = round(ats * ATS_FACTOR, 2)
                a["gmv_source"] = ATS_SOURCE
                a["gmv_is_floor"] = False
                a["buy_gmv_estimated"] = round(ats * ATS_FACTOR * BUY_TO_SELL_RATIO, 2)

    doc["_meta"] = {
        **doc.get("_meta", {}),
        "universe": len(accounts),
        "companies_universe_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "class_rule": "COMPANIES: Production - Live + Customer → Client; Implementation* → Pre-live; resto → Prospect",
        "ats_fallback": f"Est GMV = Annual Total Sales × {ATS_FACTOR} cuando no hay otra fuente",
    }

    print(f"companies en Snowflake: {len(companies)}   filas en accounts_v3: {len(accounts)}\n")
    for k, n in sorted(log.items(), key=lambda kv: -kv[1]):
        print(f"   {n:5}  {k}")
    clases = collections.Counter(a.get("account_class") for a in accounts)
    print(f"\nclases: {dict(clases)}")
    print("\ncuentas que cambian de clase:")
    for nombre, antes, despues in sorted(movidas, key=lambda m: (m[2], str(m[0]))):
        print(f"   {str(nombre)[:45]:46} {antes:>12} → {despues}")

    if args.dry_run:
        print("\n--dry-run: no se escribió nada")
        return 0
    out = DATA / "accounts_v3.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nescrito: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
