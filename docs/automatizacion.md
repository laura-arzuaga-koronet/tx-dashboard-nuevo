# Refresco automático — qué falta para encenderlo

Estado: **borrador, no operativo.** El workflow (`.github/workflows/refresh-data.yml`)
y los scripts (`extract_snowflake.py`, `validate_data.py`) están escritos, pero no
corren hasta que exista un usuario de servicio de Snowflake.

## Lo que ya está y lo que falta

| Pieza | Estado |
|---|---|
| Workflow programado | ✅ escrito |
| Consultas versionadas | ✅ `sql/cubes/` y `sql/evidence/` |
| Scripts que arman los JSON | ✅ 6 en `scripts/` |
| Validaciones entre corridas | ✅ `validate_data.py` |
| Tests que corren sobre los datos nuevos | ✅ ya existían |
| Deploy a Pages | ✅ `deploy-pages.yml` |
| **Conexión a Snowflake desde CI** | ❌ **lo único que falta** |

Hoy la conexión pasa por el MCP de Cortex Analyst, que no existe dentro de un
runner de GitHub. Hace falta conexión directa.

## Qué pedirle a quien administra Snowflake

Un usuario de servicio con **autenticación por par de claves** (no contraseña:
las contraseñas de servicio no rotan y quedan en los logs).

```sql
CREATE USER SVC_TX_DASHBOARD
  TYPE = SERVICE
  RSA_PUBLIC_KEY = '<clave pública>'
  DEFAULT_ROLE = TX_DASHBOARD_RO
  DEFAULT_WAREHOUSE = WH_TX_DASHBOARD_XS;

CREATE ROLE TX_DASHBOARD_RO;
GRANT USAGE ON WAREHOUSE WH_TX_DASHBOARD_XS TO ROLE TX_DASHBOARD_RO;
GRANT USAGE ON DATABASE PRODUCTION TO ROLE TX_DASHBOARD_RO;
GRANT USAGE ON SCHEMA PRODUCTION.ANALYTICS TO ROLE TX_DASHBOARD_RO;
GRANT SELECT ON ALL TABLES IN SCHEMA PRODUCTION.ANALYTICS TO ROLE TX_DASHBOARD_RO;
GRANT SELECT ON ALL VIEWS  IN SCHEMA PRODUCTION.ANALYTICS TO ROLE TX_DASHBOARD_RO;
GRANT ROLE TX_DASHBOARD_RO TO USER SVC_TX_DASHBOARD;
```

Solo lectura, un solo esquema, warehouse XS propio (así el costo del refresco es
medible por separado y no compite con nadie). Conviene además una
`NETWORK POLICY` con los rangos de IP de GitHub Actions, si la política de la
empresa lo permite.

## Secrets del repo

| Secret | Qué es |
|---|---|
| `SNOWFLAKE_ACCOUNT` | identificador de cuenta (`orgname-account`) |
| `SNOWFLAKE_USER` | `SVC_TX_DASHBOARD` |
| `SNOWFLAKE_ROLE` | `TX_DASHBOARD_RO` |
| `SNOWFLAKE_WAREHOUSE` | `WH_TX_DASHBOARD_XS` |
| `SNOWFLAKE_PRIVATE_KEY` | la clave privada en PEM, entera |
| `SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | si la clave está cifrada |

## Antes de encenderlo: la visibilidad del repo

**El repo es público, y por lo tanto los datos también.** Verificado el
2026-09-14: `https://laura-arzuaga-koronet.github.io/tx-dashboard-nuevo/data/gmv_pacing.json`
responde a cualquiera, sin credenciales, con el GMV por empresa de las 4.026
cuentas. Lo mismo el resto de los 20 archivos.

Eso ya es así desde que se habilitó Pages; la automatización no lo causa, pero
lo vuelve permanente y actualizado. Y **poner credenciales de producción en los
secrets de un repo público personal** es una decisión aparte, que conviene que
tome alguien más que quien escribe el workflow.

Opciones, de menos a más trabajo:

1. Mover el repo a la organización de Koronet con Pages privado (requiere plan
   Enterprise para que Pages respete el acceso).
2. Publicar en Vercel o Netlify con protección por contraseña o SSO, y dejar
   GitHub solo como repositorio privado.
3. Dejarlo público a conciencia, si el equipo evalúa que este dato no es
   sensible. Es una respuesta válida — lo que no es válido es que sea el
   default por no haberlo mirado.

Mientras siga público, mi recomendación es no cargar los secrets.

## Costo

Un warehouse XS despierto ~5 minutos por corrida, 5 corridas por semana. Los
minutos de GitHub Actions son gratis en repos públicos.

## Peso de la historia

Cada corrida agrega ~1,3 MB comprimidos al repo. Con 5 por semana son unos
330 MB al año. Dos cosas ayudan:

- **Escribir los JSON con un registro por línea.** Hoy salen minificados en una
  sola línea, así que git no puede delta-comprimirlos y guarda el archivo entero
  de nuevo cada vez. Es un cambio de una línea en cada `rebuild_*.py`
  (`separators` + `indent=None` con saltos por registro).
- **Sacar los datos de `main`**: una rama `data` con su propia historia, o subir
  los JSON como artefacto del build sin pasar por git.

Ninguna de las dos es urgente el primer mes, pero cuanto más tarde se hagan, más
historia hay que reescribir.
