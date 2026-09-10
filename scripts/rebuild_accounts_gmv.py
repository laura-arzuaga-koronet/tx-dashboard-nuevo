#!/usr/bin/env python3
"""
Recalcula la cascada de Est GMV de accounts_v3.json desde el cubo de sell actual.

POR QUÉ EXISTE
--------------
`accounts_v3.json` traía `_meta.generated = "backfill Laura"` — sin fecha — y su
`gmv_reference` etiquetado "Medido" ya no coincidía con lo que mide el cubo: de
las 41 cuentas del portafolio con esa etiqueta, la mediana medía 0,83 de lo que
la etiqueta afirmaba, Ninfa Flowers 0,13 y FreshLink arrastraba $639 contra
$3,92M de venta real en 2025. El desfase viene de que el archivo se generó antes
de que el cubo incorporara el guard R4 (`sales < 100000`), la deduplicación por
`sale_item_id` y la separación de auto-ventas — cada una baja el GMV medido.

Intenté reproducir la definición original y no se pudo: ninguna ventana del cubo
viejo explica las etiquetas (la mejor, 12 meses anualizados, deja solo 130 de 208
cuentas dentro de ±10%). Así que acá se DEFINE la métrica de forma explícita y
reproducible en vez de adivinarla.

DEFINICIÓN DE "Medido"
----------------------
Ventana: los 12 meses cerrados del cubo (`_meta.period_to` hacia atrás). El cubo
ya aplica ks_flag, R4, la deduplicación y excluye auto-ventas, así que no hay que
volver a filtrar acá.

    medido          = SUM(sell_gmv) en la ventana
    meses_con_venta = meses distintos con sell_gmv > 0

Anualizar o no depende de si la cuenta SIGUE vendiendo al cierre de la ventana:

  · 12 meses completos          → anual = medido (el factor es 1)
  · vendió en el último mes     → anual = medido × 12 / meses_con_venta
                                  Es un run-rate: la cuenta arrancó hace poco y
                                  proyectarla es razonable.
  · dejó de vender antes        → anual = medido, SIN anualizar, y se marca
                                  'Medido (parcial)' con el último mes de venta.
                                  Anualizar acá inventaría volumen que la cuenta
                                  ya no genera.

CASCADA
-------
1. Si medimos venta y el estimado externo previo era MENOR → 'Piso de red'.
2. Si medimos venta y no había estimado, o el previo ya era Medido/Piso → 'Medido'.
3. Si el estimado externo previo era MAYOR que lo medido → se respeta el externo.
   No lo tocamos: es investigación, no medición, y decidir cuál gana está
   pendiente del equipo (el desacuerdo con el ORA es de 12,44x en la mediana).
4. Si la cuenta tenía etiqueta Medido/Piso y hoy no medimos nada:
   · vendió en algún momento → 'Medido (histórico)' con la última anual conocida.
   · nunca vendió            → 'Sin dato'.
5. buy_gmv_estimated = gmv_reference × 0,45 (ratio de Christine) siempre que haya
   gmv_reference. El piso de compra medida lo aplica el adapter en runtime, así
   que acá NO se hornea.

Campos nuevos por cuenta, para que el número sea auditable sin volver a correr
esto: gmv_measured_annual, gmv_measured_sum, gmv_months_observed,
gmv_measured_window, gmv_last_sale_month, gmv_annualized.

USO
---
    python3 scripts/rebuild_accounts_gmv.py            # escribe el archivo
    python3 scripts/rebuild_accounts_gmv.py --dry-run  # solo reporta
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
BUY_TO_SELL_RATIO = 0.45

#: Fuentes que son investigación externa, no medición nuestra. No se sobreescriben
#: salvo que lo medido las supere (regla del piso de red).
EXTERNAL_SOURCES = {
    "Estimado",
    "Estimado (verificar)",
    "Estimado (AnnualRevenue×0.11)",
    "ORA",
    "FCS",
}
#: Fuentes que afirman ser nuestra medición: se recalculan siempre.
MEASURED_SOURCES = {"Medido", "Piso de red", "Piso (solo K2K)", "Medido (histórico)", "Medido (parcial)"}


def shift_month(key: str, delta: int) -> str:
    y, m = (int(x) for x in key.split("-"))
    total = y * 12 + (m - 1) + delta
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def load(name: str):
    with open(DATA / name, encoding="utf-8") as fh:
        return json.load(fh)


def money(v) -> str:
    if v is None:
        return "—"
    v = float(v)
    if abs(v) >= 1e6:
        return f"${v / 1e6:.2f}M"
    if abs(v) >= 1e3:
        return f"${v / 1e3:.0f}K"
    return f"${v:.0f}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="no escribe, solo reporta")
    args = ap.parse_args()

    cube = load("current/sell_monthly.json")
    anchor = cube["_meta"]["period_to"]
    win_from, win_to = shift_month(anchor, -11), anchor

    # venta por cuenta × mes, sobre TODO el cubo (la ventana se filtra después;
    # los meses de afuera sirven para el caso 'histórico')
    by_month: dict[str, dict[str, float]] = collections.defaultdict(lambda: collections.defaultdict(float))
    for r in cube["data"]:
        by_month[str(r["company_id"])][r["month"]] += float(r.get("sell_gmv") or 0)

    def measure(cid: str):
        """(anual, suma, meses, ultimo_mes_de_venta, se_anualizo) para la ventana."""
        meses = by_month.get(cid, {})
        en_ventana = {m: v for m, v in meses.items() if win_from <= m <= win_to and v > 0}
        vendidos = sorted(en_ventana)
        if not vendidos:
            return None, 0.0, 0, None, False
        suma = sum(en_ventana.values())
        n = len(vendidos)
        ultimo = vendidos[-1]
        if n == 12 or ultimo < win_to:
            # completo (factor 1) o dejó de vender dentro de la ventana: no anualizar
            return suma, suma, n, ultimo, False
        return suma * 12 / n, suma, n, ultimo, True

    def last_sale_ever(cid: str):
        meses = [m for m, v in by_month.get(cid, {}).items() if v > 0]
        return max(meses) if meses else None

    def historic_annual(cid: str):
        """Anual de los últimos 12 meses que SÍ tuvieron venta, para cuentas que pararon."""
        ultimo = last_sale_ever(cid)
        if not ultimo:
            return None, None
        desde = shift_month(ultimo, -11)
        vals = {m: v for m, v in by_month[cid].items() if desde <= m <= ultimo and v > 0}
        if not vals:
            return None, ultimo
        return sum(vals.values()), ultimo

    doc = load("accounts_v3.json")
    accounts = doc["accounts"]
    cambios = collections.Counter()
    detalle: list[tuple] = []

    for a in accounts:
        cid = str(a.get("company_id")) if a.get("company_id") is not None else None
        src_prev = a.get("gmv_source") or None
        ref_prev = float(a["gmv_reference"]) if a.get("gmv_reference") not in (None, "") else None

        anual, suma, meses, ultimo, anualizado = (None, 0.0, 0, None, False)
        if cid:
            anual, suma, meses, ultimo, anualizado = measure(cid)

        # trazabilidad, siempre
        a["gmv_measured_window"] = f"{win_from}..{win_to}"
        a["gmv_measured_sum"] = round(suma, 2) if suma else 0
        a["gmv_months_observed"] = meses
        a["gmv_measured_annual"] = round(anual, 2) if anual else None
        a["gmv_annualized"] = anualizado
        a["gmv_last_sale_month"] = last_sale_ever(cid) if cid else None

        if anual and anual > 0:
            if src_prev in EXTERNAL_SOURCES and ref_prev and ref_prev >= anual:
                cambios["externo respetado (mayor que lo medido)"] += 1
                continue
            nuevo_src = "Piso de red" if (src_prev in EXTERNAL_SOURCES and ref_prev) else "Medido"
            if ultimo and ultimo < win_to:
                nuevo_src = "Medido (parcial)"
            if src_prev != nuevo_src or ref_prev != round(anual, 2):
                cambios[f"{src_prev or '(sin fuente)'} → {nuevo_src}"] += 1
                detalle.append((a.get("company_name"), src_prev, ref_prev, nuevo_src, anual))
            a["gmv_reference"] = round(anual, 2)
            a["gmv_source"] = nuevo_src
            a["gmv_is_floor"] = nuevo_src.startswith("Piso")
            a["buy_gmv_estimated"] = round(anual * BUY_TO_SELL_RATIO, 2)
        elif src_prev in MEASURED_SOURCES:
            hist, ultimo_ever = historic_annual(cid) if cid else (None, None)
            if hist:
                cambios[f"{src_prev} → Medido (histórico)"] += 1
                detalle.append((a.get("company_name"), src_prev, ref_prev, "Medido (histórico)", hist))
                a["gmv_reference"] = round(hist, 2)
                a["gmv_source"] = "Medido (histórico)"
                a["gmv_is_floor"] = False
                a["buy_gmv_estimated"] = round(hist * BUY_TO_SELL_RATIO, 2)
            else:
                cambios[f"{src_prev} → Sin dato (nunca medimos venta)"] += 1
                detalle.append((a.get("company_name"), src_prev, ref_prev, "Sin dato", None))
                a["gmv_reference"] = None
                a["gmv_source"] = "Sin dato"
                a["gmv_is_floor"] = False
                a["buy_gmv_estimated"] = None

    doc["_meta"] = {
        **doc.get("_meta", {}),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_by": "scripts/rebuild_accounts_gmv.py",
        "gmv_method": (
            "Medido = SUM(sell_gmv) sobre los 12 meses cerrados del cubo "
            f"({win_from}..{win_to}); se anualiza por meses con venta solo si la "
            "cuenta seguía vendiendo en el último mes de la ventana. Piso de red "
            "cuando lo medido supera un estimado externo. Los estimados externos "
            "mayores que lo medido se respetan."
        ),
        "gmv_window": f"{win_from}..{win_to}",
        "cube_generated_at": cube["_meta"].get("generated_at"),
        "rules_applied": ["R1 ks_flag", "R4 sales<100000", "R5/R16 dedup sale_item_id", "auto-ventas excluidas"],
        "universe": len(accounts),
    }

    print(f"ventana: {win_from} .. {win_to}   (cubo generado {cube['_meta'].get('generated_at')})")
    print(f"cuentas: {len(accounts)}\n")
    print("cambios de fuente:")
    for k, n in cambios.most_common():
        print(f"   {n:5}  {k}")

    print("\nlos 12 movimientos más grandes en valor absoluto:")
    detalle.sort(key=lambda d: -abs((d[4] or 0) - (d[2] or 0)))
    for nombre, sp, rp, sn, rn in detalle[:12]:
        print(f"   {str(nombre)[:30]:31} {str(sp or '—')[:22]:23} {money(rp):>9}  →  {sn[:20]:21} {money(rn):>9}")

    con = sum(1 for a in accounts if a.get("gmv_reference"))
    print(f"\ncuentas con gmv_reference: {con}  (antes 528)")

    if args.dry_run:
        print("\n--dry-run: no se escribió nada")
        return 0
    out = DATA / "accounts_v3.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"\nescrito: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
