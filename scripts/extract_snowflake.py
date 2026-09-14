#!/usr/bin/env python3
"""
Corre las consultas de sql/ contra Snowflake y deja los result sets crudos en
una carpeta de staging, listos para los scripts rebuild_*.py.

BORRADOR: no se puede correr hasta que exista un usuario de servicio. Ver
docs/automatizacion.md para los secrets y los grants que hay que pedir.

POR QUÉ ESTE SCRIPT EXISTE
--------------------------
El MCP de Cortex no existe dentro de un runner de GitHub Actions, así que la
automatización necesita conexión directa. Eso tiene una consecuencia buena: se
cae la restricción de vistas semánticas, y por lo tanto `inventory_current`
—que hoy hay que correr a mano porque no hay INVENTORY_DETAILS_SV— pasa a ser
automatizable como cualquier otra fuente.

Y una consecuencia peligrosa: sin Cortex de por medio, nadie revisa el SQL
antes de ejecutarlo. Las reglas del modelo (R1 ks_flag, R4 sales<100000 POR
LÍNEA y nunca en HAVING, R5/R16 dedup por sale_item_id) dejan de estar
garantizadas por la herramienta y pasan a depender de que los .sql del repo
estén bien. Por eso este script no arma SQL: solo ejecuta, tal cual, los
archivos versionados en sql/, que son los que ya se revisaron.

TRUNCADO SILENCIOSO
-------------------
Snowflake puede devolver menos filas de las que dice tener sin avisar. Cada
consulta compara el total declarado contra lo que efectivamente llegó y aborta
si no coinciden. Nos pasó antes y es el tipo de error que no se nota hasta que
alguien pregunta por qué bajó un número.

USO
---
    python3 scripts/extract_snowflake.py --out /tmp/staging
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent

#: destino → (archivo .sql, índice del statement dentro de ese archivo)
#:
#: El índice es explícito a propósito: varios .sql traen una segunda consulta
#: (totales de red, cortes alternativos) que NO va al JSON. Elegirlas por
#: número acá deja el mapeo auditable en un solo lugar, en vez de esconderlo
#: en un parser que adivina.
MANIFIESTO: dict[str, tuple[str, int]] = {
    "sell_monthly":   ("sql/cubes/sell_monthly.sql", 0),
    "buy_monthly":    ("sql/cubes/buy_monthly.sql", 0),
    "fees_monthly":   ("sql/cubes/fees_monthly.sql", 0),
    "catalog_sell":   ("sql/evidence/catalog_reach.sql", 0),
    "catalog_buy":    ("sql/evidence/catalog_reach.sql", 1),
    "inventory":      ("sql/evidence/inventory_current.sql", 0),
    # Pendientes de cablear: hardgoods, config_evidence, buyers, vendors,
    # temporal. Sus .sql están en sql/evidence pero conviene sumarlos de a uno
    # y comparar contra la corrida manual antes de confiar en ellos.
}


def statements(path: pathlib.Path) -> list[str]:
    """Separa un .sql en statements, sacando primero los comentarios.

    Los archivos del repo están llenos de comentarios que contienen ';' (y
    hasta consultas enteras comentadas), así que partir el texto crudo por ';'
    devuelve basura. Se limpian las líneas de comentario y recién ahí se parte.
    """
    limpio = []
    for linea in path.read_text(encoding="utf-8").splitlines():
        sin_comentario = re.sub(r"--.*$", "", linea)
        if sin_comentario.strip():
            limpio.append(sin_comentario)
    return [s.strip() for s in "\n".join(limpio).split(";") if s.strip()]


def conectar():
    """Conexión con key-pair. Nunca usuario y contraseña en CI."""
    try:
        import snowflake.connector
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        sys.exit("falta snowflake-connector-python[secure-local-storage]")

    pem = os.environ.get("SNOWFLAKE_PRIVATE_KEY")
    if not pem:
        sys.exit("falta SNOWFLAKE_PRIVATE_KEY")
    clave = serialization.load_pem_private_key(
        pem.encode(),
        password=(os.environ["SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"].encode()
                  if os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE") else None),
    ).private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        role=os.environ["SNOWFLAKE_ROLE"],
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        private_key=clave,
        # El runner es efímero: nada de cachear credenciales en disco.
        client_store_temporary_credential=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="carpeta de staging")
    ap.add_argument("--only", help="extraer solo esta clave del manifiesto")
    a = ap.parse_args()

    destino = pathlib.Path(a.out)
    destino.mkdir(parents=True, exist_ok=True)
    claves = [a.only] if a.only else list(MANIFIESTO)

    conn = conectar()
    fallos = []
    try:
        for clave in claves:
            archivo, idx = MANIFIESTO[clave]
            sql = statements(ROOT / archivo)[idx]
            cur = conn.cursor()
            cur.execute(sql)
            filas = cur.fetchall()
            columnas = [c[0] for c in cur.description]

            # Truncado silencioso: lo que dice haber contra lo que llegó.
            declaradas = cur.rowcount
            if declaradas is not None and declaradas >= 0 and declaradas != len(filas):
                fallos.append(f"{clave}: Snowflake declara {declaradas} filas y llegaron {len(filas)}")
                continue
            if not filas:
                fallos.append(f"{clave}: 0 filas — una fuente vacía no es un refresco válido")
                continue

            (destino / f"{clave}.json").write_text(json.dumps({
                "columns": columnas,
                "data": [[None if v is None else str(v) for v in f] for f in filas],
                "_extract": {
                    "sql": f"{archivo}#{idx}",
                    "rows": len(filas),
                    "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "query_id": cur.sfqid,
                },
            }, ensure_ascii=False), encoding="utf-8")
            print(f"  {clave:15} {len(filas):>8,} filas  ({cur.sfqid})")
            cur.close()
    finally:
        conn.close()

    if fallos:
        print("\nEXTRACCIÓN ABORTADA:", file=sys.stderr)
        for f in fallos:
            print(f"  · {f}", file=sys.stderr)
        return 1
    print(f"\n{len(claves)} fuentes en {destino}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
