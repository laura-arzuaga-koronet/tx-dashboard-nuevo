-- ============================================================================
-- inventory_current  →  reemplaza public/data/inventory_current_v1.json
-- Grano  : company × inventory_type × inventory_division
-- Fuente : PRODUCTION.ANALYTICS.INVENTORY_DETAILS
-- Estado : ⛔ NO EJECUTABLE DESDE EL MCP DE CORTEX — ver nota abajo.
--          Referencia lista para correr con acceso directo a Snowflake.
-- ----------------------------------------------------------------------------
-- POR QUÉ NO SE PUEDE EJECUTAR DESDE ACÁ
--
-- `sql_exec_tool` solo ejecuta SQL generado por Cortex Analyst y contra vistas
-- semánticas (sufijo _SV). No existe INVENTORY_DETAILS_SV: el modelo semántico
-- no expone inventario. Se verificó preguntando a tres dominios de Cortex
-- (companies, products, procurements): los tres responden que no hay stock on
-- hand. Procurements aclara que al inventario se llega *a través* de órdenes de
-- compra y recepciones, pero no hay balance en vivo.
--
-- El propio archivo anterior ya lo documentaba como excepción a la Regla 8:
--   "Rule 8: EXCEPTION -- no INVENTORY_DETAILS_SV exists; this is the only
--    inventory table"
--
-- O sea que la corrida del 2026-08-06 también tuvo que ir contra la tabla base.
-- Para refrescarlo hace falta acceso directo, o crear la vista semántica.
--
-- ----------------------------------------------------------------------------
-- CAVEATS QUE VIENEN DEL ARCHIVO ANTERIOR — siguen valiendo
--
--   · Es un LIBRO ACUMULADO, no una foto del stock actual. `total_units > 0`
--     es un proxy de "ítems con existencia" pero incluye entradas históricas
--     que pueden ya no estar activas.
--   · No hay columna de fecha de publicación ni de listado, así que no se puede
--     confirmar visibilidad real en el eShop. Por eso el label del JSON dice
--     "proxy -- Not confirmed eShop visibility".
--   · Regla 7: el vendor viene en blanco en algunas filas de Units, por diseño.
--
-- NOMBRES DE COLUMNA — confirmados contra el esquema real (2026-09-10)
--   Tres de los que había inferido estaban mal:
--     inventory_type_code → INVENTORY_TYPE        (sin sufijo _code)
--     category_name       → PRODUCT_CATEGORY_NAME
--     variety_name        → PRODUCT_VARIETY
--   Y hay algo mejor: KS_FLAG y COMPANY_NAME están EN la propia tabla, así que
--   el JOIN contra COMPANIES sobra. Una tabla, sin joins.
--
-- Consumido por: buildList() → inventory_current (tarjeta LIST, tablas "By type"
-- y "By division") y por el conteo de fuentes de la tarjeta DATA COVERAGE.
-- ============================================================================

-- ── 1. Grano completo: company × tipo × división ─────────────────────────────
-- El JSON necesita dos cortes independientes (by_inventory_type y
-- by_inventory_division). Se extrae el grano cruzado una sola vez y los dos
-- cortes se agregan después, en vez de pegarle dos veces a la tabla.
WITH base AS (
    SELECT
        COMPANY_ID,
        COMPANY_NAME,
        -- El tipo viene NULL/'' para el on-hand. El JSON lo etiqueta '(blank)'
        -- y lo nombra on_hand: se conserva ese contrato.
        COALESCE(NULLIF(TRIM(INVENTORY_TYPE), ''), '(blank)') AS inventory_type_code,
        INVENTORY_DIVISION,
        PRODUCT_ID,
        PRODUCT_CATEGORY_NAME,
        PRODUCT_VARIETY,
        TOTAL_UNITS,
        INVENTORY_ID
    FROM PRODUCTION.ANALYTICS.INVENTORY_DETAILS
    WHERE KS_FLAG = TRUE            -- Regla 1: fuera demo y test
      AND TOTAL_UNITS > 0           -- proxy de "tiene existencia"
),

-- ── 2. Corte por tipo de inventario ──────────────────────────────────────────
por_tipo AS (
    SELECT
        COMPANY_ID,
        COMPANY_NAME,
        inventory_type_code,
        -- nombre que usa el JSON para cada código
        CASE inventory_type_code
            WHEN '(blank)' THEN 'on_hand'
            WHEN 'L'       THEN 'limited'
            WHEN 'M'       THEN 'open_market'
            WHEN 'P'       THEN 'prebook'
            WHEN 'S'       THEN 'standing_order'
            ELSE LOWER(inventory_type_code)
        END                                   AS bucket,
        -- COUNT(*) reproduce el item_count del archivo anterior. Si se prefiere
        -- contar ítems y no filas, INVENTORY_ID está disponible:
        --   COUNT(DISTINCT INVENTORY_ID) AS item_count
        COUNT(*)                              AS item_count,
        COUNT(DISTINCT PRODUCT_ID)            AS unique_products,
        COUNT(DISTINCT PRODUCT_CATEGORY_NAME) AS unique_categories,
        COUNT(DISTINCT PRODUCT_VARIETY)       AS unique_varieties,
        SUM(TOTAL_UNITS)                      AS total_units
    FROM base
    GROUP BY 1, 2, 3, 4
),

-- ── 3. Corte por división ────────────────────────────────────────────────────
por_division AS (
    SELECT
        COMPANY_ID,
        COMPANY_NAME,
        INVENTORY_DIVISION,                   -- Boxes | Units | Hard Goods
        -- COUNT(*) reproduce el item_count del archivo anterior. Si se prefiere
        -- contar ítems y no filas, INVENTORY_ID está disponible:
        --   COUNT(DISTINCT INVENTORY_ID) AS item_count
        COUNT(*)                              AS item_count,
        COUNT(DISTINCT PRODUCT_ID)            AS unique_products,
        COUNT(DISTINCT PRODUCT_CATEGORY_NAME) AS unique_categories,
        COUNT(DISTINCT PRODUCT_VARIETY)       AS unique_varieties,
        SUM(TOTAL_UNITS)                      AS total_units
    FROM base
    GROUP BY 1, 2, 3
)

-- ── 4. Salida en un solo result set ──────────────────────────────────────────
-- `grouping` distingue las dos mitades para que el script que arma el JSON las
-- separe sin tener que correr dos consultas.
SELECT 'by_inventory_type' AS grouping,
       COMPANY_ID, COMPANY_NAME,
       bucket              AS bucket,
       inventory_type_code AS code,
       item_count, unique_products, unique_categories, unique_varieties, total_units
FROM por_tipo

UNION ALL

SELECT 'by_inventory_division',
       COMPANY_ID, COMPANY_NAME,
       INVENTORY_DIVISION,
       NULL,
       item_count, unique_products, unique_categories, unique_varieties, total_units
FROM por_division

ORDER BY COMPANY_ID, grouping, bucket;

-- ============================================================================
-- TOTALES DE RED (network_summary del JSON)
--
-- No se pueden sumar los cortes de arriba: unique_products / categories /
-- varieties requieren deduplicación cruzada entre tipos y entre empresas. El
-- propio JSON lo advierte en `totals.note`. Por eso van en consulta aparte.
-- ============================================================================
-- WITH base AS ( ...igual que arriba... )
-- SELECT
--     COUNT(*)                              AS total_items,
--     COUNT(DISTINCT COMPANY_ID)            AS total_companies,
--     COUNT(DISTINCT PRODUCT_ID)            AS total_unique_products,
--     COUNT(DISTINCT PRODUCT_CATEGORY_NAME) AS total_unique_categories,
--     COUNT(DISTINCT PRODUCT_VARIETY)       AS total_unique_varieties,
--     SUM(TOTAL_UNITS)                      AS total_units
-- FROM base;
--
-- Referencia de la corrida 2026-08-06, para comparar cuando se re-extraiga:
--   total_items 6.702.426 · companies 436 · products 174.970
--   categories 2.995 · varieties 49.763 · units 8.338.020.120
--
-- ============================================================================
-- CÓMO ARMAR EL JSON DESPUÉS
--
-- El adapter lee `companies` indexado por company_id (igual que
-- config_evidence_v2), con esta forma por empresa:
--
--   { company_id, company_name,
--     by_inventory_type:     { on_hand: {inventory_type_code, item_count,
--                                        unique_products, unique_categories,
--                                        unique_varieties, total_units}, ... },
--     by_inventory_division: { Boxes: {item_count, ...}, Units: {...} },
--     totals:                { total_items, total_units, note } }
--
-- Guardar el result set como JSON {columns, data} y pasarlo por un script
-- equivalente a scripts/rebuild_config_evidence.py. Acordarse de escribir
-- `_metadata.generated_at`: la falta de fecha en accounts_v3 fue justo lo que
-- dejó pasar meses de desfase sin que nadie lo notara.
-- ============================================================================
