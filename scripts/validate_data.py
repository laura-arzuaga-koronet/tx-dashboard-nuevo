#!/usr/bin/env python3
"""
Compara los JSON recién generados contra los que están commiteados y aborta si
el cambio tiene forma de error en vez de forma de dato nuevo.

QUÉ ATRAPA Y POR QUÉ
--------------------
Cada regla acá salió de algo que ya pasó en este proyecto, no de una lista
genérica de buenas prácticas:

  · fuente vacía         una consulta que devuelve 0 filas y se publica igual
  · archivo que encoge   la fuente cambió de forma y nadie miró
  · el cubo retrocede    extracción parcial: el último mes desaparece
  · salto de cuentas     4.014 cuentas quedaron sin config por indexar por
                         nombre en vez de company_id
  · salto de GMV         un filtro que se cae cambia el total de golpe
  · sin generated_at     la falta de fecha en accounts_v3 dejó pasar meses de
                         desfase sin que nadie lo notara
  · cambio de indexado   un archivo que iba por company_id pasa a ir por nombre,
                         o trae "1,241" con separador de miles sin normalizar

Los umbrales son deliberadamente anchos. Esto no busca detectar que un número
cambió —para eso está el diff del PR— sino que la corrida se rompió.

USO
---
    python3 scripts/validate_data.py --nuevos public/data --anteriores /tmp/base
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

#: Variación aceptable en el conteo de cuentas entre corridas.
TOL_CUENTAS = 0.05
#: Variación aceptable en el GMV total del cubo de sell.
TOL_GMV = 0.15
#: Cuánto puede encoger un archivo antes de sospechar.
TOL_TAMANO = 0.20


def cargar(p: pathlib.Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001 — cualquier fallo de lectura es un fallo de validación
        return {"__error__": str(e)}


def gmv_total(cubo) -> float:
    return sum(float(r.get("sell_gmv") or 0) for r in cubo.get("data", []))


def ultimo_mes(cubo) -> str | None:
    meses = [r.get("month") for r in cubo.get("data", []) if r.get("month")]
    return max(meses) if meses else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--nuevos", required=True)
    ap.add_argument("--anteriores", required=True)
    a = ap.parse_args()
    nuevo, viejo = pathlib.Path(a.nuevos), pathlib.Path(a.anteriores)

    errores: list[str] = []
    avisos: list[str] = []

    archivos = sorted(p.relative_to(nuevo) for p in nuevo.rglob("*.json"))
    if not archivos:
        print("no hay JSON que validar", file=sys.stderr)
        return 1

    for rel in archivos:
        n, v = nuevo / rel, viejo / rel
        doc = cargar(n)
        if "__error__" in doc:
            errores.append(f"{rel}: no se puede parsear ({doc['__error__']})")
            continue

        # fecha de generación
        meta = doc.get("_metadata") or doc.get("_meta") or {}
        if not (meta.get("generated_at") or meta.get("generated")):
            avisos.append(f"{rel}: sin generated_at")

        if not v.exists():
            avisos.append(f"{rel}: archivo nuevo, sin base contra la cual comparar")
            continue

        # tamaño
        antes, ahora = v.stat().st_size, n.stat().st_size
        if ahora < antes * (1 - TOL_TAMANO):
            errores.append(f"{rel}: encogió {100 * (1 - ahora / antes):.0f}% "
                           f"({antes / 1024:.0f} KB → {ahora / 1024:.0f} KB)")

        # conteo de registros, sea lista o dict
        for campo in ("accounts", "data", "companies", "pacing", "estimates"):
            if campo in doc:
                prev = cargar(v)
                a_n, a_v = doc[campo], prev.get(campo, [])
                if isinstance(a_n, (list, dict)) and isinstance(a_v, (list, dict)) and len(a_v):
                    delta = abs(len(a_n) - len(a_v)) / len(a_v)
                    if delta > TOL_CUENTAS:
                        errores.append(f"{rel}: {campo} pasó de {len(a_v):,} a {len(a_n):,} "
                                       f"({delta:.0%})")
                break

    # Indexado por company_id: chequeo por REGRESIÓN, no absoluto.
    #
    # No sirve exigir claves numéricas en todos lados: buyers_evidence_v2 y
    # skus_online_offline vienen indexados por NOMBRE de la época en que se
    # generaron, y el adapter los reindexa leyendo el company_id de adentro del
    # registro. Lo que sí importa es que un archivo que HOY va por id no pase a
    # ir por nombre (o a traer "1,241" con separador de miles) sin que nadie lo
    # note: eso fue lo que dejó 4.014 cuentas sin fila de config.
    def numericas(doc) -> float | None:
        comps = doc.get("companies")
        if not isinstance(comps, dict) or not comps:
            return None
        muestra = list(comps)[:200]
        return sum(1 for k in muestra if str(k).isdigit()) / len(muestra)

    for rel in archivos:
        if not (viejo / rel).exists():
            continue
        antes_n, ahora_n = numericas(cargar(viejo / rel)), numericas(cargar(nuevo / rel))
        if antes_n is None or ahora_n is None:
            continue
        if antes_n > 0.9 and ahora_n < 0.9:
            malas = [k for k in list(cargar(nuevo / rel)["companies"])[:200] if not str(k).isdigit()]
            errores.append(f"{rel}: estaba indexado por company_id y ahora no ({malas[:3]}) "
                           "— probable separador de miles sin normalizar")

    # el cubo de sell no puede retroceder ni saltar de golpe
    n_sell, v_sell = nuevo / "current/sell_monthly.json", viejo / "current/sell_monthly.json"
    if n_sell.exists() and v_sell.exists():
        cn, cv = cargar(n_sell), cargar(v_sell)
        mn, mv = ultimo_mes(cn), ultimo_mes(cv)
        if mn and mv and mn < mv:
            errores.append(f"sell_monthly: el último mes retrocedió de {mv} a {mn}")
        gn, gv = gmv_total(cn), gmv_total(cv)
        if gv and abs(gn - gv) / gv > TOL_GMV:
            errores.append(f"sell_monthly: el GMV total cambió {100 * (gn - gv) / gv:+.0f}% "
                           f"(${gv / 1e6:,.0f}M → ${gn / 1e6:,.0f}M)")
        elif gv:
            print(f"sell_monthly: GMV {100 * (gn - gv) / gv:+.1f}% · último mes {mn}")

    for a_ in avisos:
        print(f"⚠ {a_}")
    if errores:
        print("\nVALIDACIÓN FALLIDA:", file=sys.stderr)
        for e in errores:
            print(f"  · {e}", file=sys.stderr)
        return 1
    print(f"\n{len(archivos)} archivos validados, sin bloqueantes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
