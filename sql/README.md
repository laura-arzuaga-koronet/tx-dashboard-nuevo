# Fuentes de datos → queries

Mapa de cada JSON que hoy lee el adapter (`public/data/`) a la query que lo reemplazará cuando el
dashboard tome datos de Snowflake / Salesforce (vía Lovable + Supabase). El objetivo es que
`src/data/adapter/builders.ts` no cambie: cada query devuelve las **mismas columnas** que el JSON.

## Estado

| JSON actual | Reemplazo | Fuente | Estado |
|---|---|---|---|
| `current/sell_monthly.json` | `cubes/sell_monthly.sql` | `SALE_DETAILS` | ✅ Lista · semántica de canales **validada** (2026-09-08) · ⚠ el cubo va 1 mes atrasado |
| `current/buy_monthly.json` | `cubes/buy_monthly.sql` | `PROCUREMENT_DETAILS` | ✅ Lista · split online/offline **validado** (2026-09-08) |
| `current/fees_monthly.json` | `cubes/fees_monthly.sql` | `TRANSACTION_FEES` (transaction_date) | ✅ Lista y **ya ejecutada** (2026-09-07): el JSON del repo tiene grano mensual real |
| `buyers_evidence_v2.json` | `evidence/buyers_evidence.sql` | `SALE_DETAILS` + `USER_STATS` | ⏳ Pegar desde chat "TX fees action plan" |
| `vendors_evidence_v2.json` | `evidence/vendors_evidence.sql` | `PROCUREMENT_DETAILS` + `K2K_CONNECTIONS` | ⏳ Pegar |
| `temporal_evidence_v2.json` · sell_anticipation | `evidence/temporal_sell_anticipation.sql` | `SALE_DETAILS` | ⏳ Pegar |
| `temporal_evidence_v2.json` · variety_freshness | `evidence/temporal_variety_freshness.sql` | `SALE_DETAILS` | ⏳ Pegar |
| `temporal_evidence_v2.json` · forward_inventory_depth | `evidence/temporal_forward_inventory.sql` | `PREBOOK_DETAILS` | ⏳ Pegar |
| `inventory_current_v1.json` | `evidence/inventory_current.sql` | `INVENTORY_DETAILS` | ⛔ **Bloqueado**: no hay vista semántica de inventario en el MCP de Cortex, y `sql_exec_tool` no ejecuta contra tablas base. Requiere acceso directo. Archivo del 2026-08-06 |
| `config_evidence_v2.json` | `evidence/config_evidence.sql` | `COMPANIES` + `COMPANY_SETTINGS` + `SALES_SV` | ✅ **Re-extraído 2026-09-10** vía `scripts/rebuild_config_evidence.py`. Ojo: las tarifas están en `COMPANIES`, no en `COMPANIES_SV`; maxAge y future-sales están en `COMPANY_SETTINGS` como pares nombre/valor **en camelCase** |
| `hardgoods_v2.json` | `evidence/hardgoods.sql` | `SALES_SV` | ⚠ **Re-extraído parcial 2026-09-10** vía `scripts/rebuild_hardgoods.py`. `inventory_division` solo tiene Boxes/Units/Hard Goods: los bloques de **plants** se preservaron del archivo viejo |
| `skus_online_offline.json` | `evidence/skus_online_offline.sql` | `SALE_DETAILS` | ⏳ Pegar |
| `gmv_pacing.json` | `evidence/gmv_pacing.sql` | derivado de sell_monthly | ✅ **Regenerado 2026-09-10** vía `scripts/rebuild_derived.py` (no necesita Snowflake) |
| `benchmarks_v2.json` | `evidence/benchmarks.sql` | derivado | ✅ **Regenerado 2026-09-10** vía `scripts/rebuild_derived.py`. Cohorte = toda la red (no el portafolio): restringirla subía la mediana de online % de 13% a 100% |
| `sfdc_open_opportunities_v1.json` | `salesforce/open_opportunities.soql` | Salesforce `Opportunity` | ✅ Lista |
| `accounts_v3.json` (columnas de sistema) | `salesforce/accounts_system_fields.soql` | Salesforce `Account` + `COMPANIES` | 📝 Borrador — confirmar join key |
| `accounts_v3.json` (columnas manuales) | `manual/schema.sql` → `tx_account_overrides` | Hoja de Christine + criterio humano | ✅ Esquema listo · seed pendiente |
| `accounts_v3.json` (cascada de Est GMV) | `scripts/rebuild_accounts_gmv.py` | cubo de sell | ✅ **Recalculado 2026-09-10**. La definición de "Medido" quedó explícita en el script: no era reproducible desde el archivo viejo |
| `gmv_estimates_external.json` | `manual/schema.sql` → `tx_gmv_estimates_external` | Investigación externa | 🚫 **No re-extraíble**: es investigación manual (headcount, ubicaciones, revenue de agregadores), no sale de Snowflake. Solo se renueva rehaciendo la investigación |
| IDs excluidos (hardcoded) | `manual/schema.sql` → `tx_excluded_company_ids` | — | ✅ Con datos |

## Reglas del modelo (aplican a toda query)

Resumen de `tx-dashboards/data/current/refresh_queries.md` y de los `_meta` de los JSON V2.

- **R1** `ks_flag = TRUE` siempre. Es el error silencioso número uno.
- **R4** `sales < 100000` en queries sobre ventas (guardia contra datos corruptos).
- **R5 / R16** Dedup por `sale_item_id` (`ROW_NUMBER` o `SELECT DISTINCT`); `customer_location_id` fuera del dedup.
- **R6** Online = `eCommerce` + `K2K` + `API`; offline = todo lo demás.
- **R8** Tablas semánticas donde existan, pero **sin** sufijo `_SV` en el nombre físico (`PRODUCTION.ANALYTICS.SALE_DETAILS`). `INVENTORY_DETAILS` y `PREBOOK_DETAILS` no tienen versión semántica.
- **R12** Excluir cuentas dump / waste / shrink (por `customer_name`).
- `SALE_STATUS = 'Confirmed'` es case-sensitive; `'confirmed'` devuelve cero filas sin error.
- Nunca filtrar solo `sale_order_type = 'Invoice'`: se pierden los prebooks de eSuite. Siempre `(Invoice AND Confirmed) OR Prebook`.
- Campo de ingreso según tabla: `sales` (SALE_DETAILS) · `total_cost` (PROCUREMENT_DETAILS) · `fee_amount` (fees). No mezclar.
- Campo de fecha según cubo: `shipping_date` (sell y buy) · `transaction_date` (fees) · `created_on_date` solo para tendencias de creación.
- `company_id` es NUMBER en SALE_DETAILS / PROCUREMENT_DETAILS y TEXT en las tablas de fees: castear al unir.
- Procurement: `sales_channel = 'Procurement'` obligatorio + exclusión de los 14 IDs internos al unir con `COMPANIES`.
- `VENDOR_NAME` en PROCUREMENT_DETAILS es local a cada comprador; para vendors canónicos usar el patrón de join K2K.
- Agregar en SQL (`GROUP BY`), nunca traer filas crudas; nombrar columnas explícitamente.
- Snowflake: sin funciones ventana anidadas (precomputar en CTE); `rows` es palabra reservada (usar `row_cnt`).

## Hallazgos al mapear (revisar antes de go-live)

1. **Fees YTD está inflado en el dashboard legacy — CORREGIDO en este repo.** `fees_monthly.json` (regenerado 2026-08-24) guardaba el YTD 2025 como una fila por compañía con `month='2025-01'` y `fee_channel='total'`, y el adapter sumaba todas las filas sin filtrar por mes, así que `fees_ytd_2026` incluía el total 2025 ($2.51M vs $1.47M reales a nivel red). Ahora el adapter filtra fees por período y el cubo se regeneró con grano mensual real (ene-2025 → ago-2026) desde `TRANSACTION_FEES` vía Cortex Analyst, mes a mes para evitar la paginación. Verificación: ene–jul 2026 = $1,473,667 (manifest legacy: $1,478K; cubo legacy: $1,466K). Nota: `bill_date` va un mes desplazado respecto a `transaction_date` (se factura en atraso); el cubo usa `transaction_date`, igual que la definición legacy. El JSON legacy quedó en `tests/fixtures/fees_monthly.legacy.json` como evidencia.
2. **Etiquetas de canal mezcladas en sell_monthly — MANEJADO en el adapter.** Los meses 2024-08 a 2025-07 usan `eCommerce` / `K2K` / `API` / `Offline`; de 2025-08 en adelante usan `Online` / `Offline`. El adapter ahora aplica la Regla 6 (`isOnlineChannel`: Online, eCommerce, K2K, API), así "Full year 2025" y "Last 12 months" dan online % coherente. `cubes/sell_monthly.sql` emite además `channel_group` normalizado para que la query nueva no dependa de esto.
3. **Split buy_online / buy_offline — RESUELTO (2026-09-08), y la hipótesis del repo era incorrecta.** `PROCUREMENT_DETAILS.sales_channel` tiene cinco valores y el cubo parte así: **online = Web + Procurement + API**, **offline = Unknown + N/A**. Verificado ene–jul 2026: online $31,483,568 en Snowflake vs $31,480,451 en el cubo (0,01%); offline $513,068,030 vs $512,878,435 (0,04%). Dos consecuencias: (a) `refresh_queries.md` dice que `sales_channel = 'Procurement'` es obligatorio — es **falso** para este cubo, porque Procurement solo son $19,3M de los $544M que reporta; (b) `Web` es un canal online real ($11,8M ene–jul 2026) y omitirlo subestimaría `buy_online_pct` en cerca de un tercio.
4. **`accounts_v3.json` es mixto.** ~600 de 4.026 cuentas tienen columnas curadas a mano (cascada Christine, prioridad, tier). Van a `tx_account_overrides`; el resto se reconstruye desde SFDC + COMPANIES.
5. **La hoja de Christine no está versionada** (el `_meta` de config apunta a un archivo local). Al sembrar `tx_account_overrides` desde `accounts_v3.json` queda capturada.
6. **Los cubos van un mes atrasado y el último mes no es estable.** Al 2026-09-08 los cubos de sell y buy llegan a jul-2026, pero **ago-2026 ya está cerrado y falta por completo**: son $97,8M de sell GMV ($20,5M online + $77,3M offline) que el dashboard no ve. Más importante: el último mes del cubo sigue moviéndose. Comparado contra la tabla base hoy, jun-2026 está +1,7% en el cubo pero **jul-2026 está −5,3%** (offline $73,2M en el cubo vs $78,7M real): entre la generación del cubo (13-ago) y hoy, julio creció ~7% porque se siguieron confirmando facturas. No es diferencia de filtro — probé cinco reglas de inclusión y ninguna explica el gap, y las desviaciones van en direcciones opuestas según el mes. Implicación de producto: el mes más reciente debe tratarse como **provisional** (o anclar los períodos en `período_to − 1`), porque el sparkline MoM y el "mes actual" del último mes se leen bajos durante 2–4 semanas.
7. **La validación exacta de los cubos necesita la tabla base, no la vista semántica.** El MCP de Cortex solo permite ejecutar SQL generado por sus modelos y prohíbe consultar tablas base directamente; algunas preguntas caen en `SALES_SV` / `PROCUREMENTS_SV` en vez de `SALE_DETAILS` / `PROCUREMENT_DETAILS`, y `refresh_queries.md` es explícito en que hay que usar la tabla base (R8) más R4 (`sales < 100000`) y R5/R16 (dedup por `sale_item_id`), que las vistas semánticas pueden aplicar distinto. Para el refresco de producción esto se resuelve con el conector de Python en GitHub Actions, que sí puede consultar la tabla base y aplicar las reglas tal cual.

## Cómo validar cada query

Mismo patrón que `tests/adapter.parity.test.ts`: correr la query, volcar el resultado al shape del JSON
y comparar contra el archivo actual en `public/data/`. Para los cubos la comparación es exacta salvo
los hallazgos 1 y 2; para las fuentes V2 la fecha de referencia (`CURRENT_DATE`) cambia los buckets
temporales, así que comparar con tolerancia o fijar la fecha en la query durante la validación.
