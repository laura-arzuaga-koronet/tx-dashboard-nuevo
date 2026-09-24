-- ============================================================================
-- catalog_reach  →  genera public/data/catalog_reach_v1.json
-- Grano  : company × (categorías | variedades | SKUs) × (total | online)
-- Fuente : SALES_SV (venta) + PROCUREMENTS_SV (compra)
-- Estado : ✅ EJECUTABLE DESDE EL MCP — las dos son vistas semánticas.
--          Corrida 2026-09-10: 368 empresas en venta, 351 en compra, 326 en ambas.
-- ----------------------------------------------------------------------------
-- QUÉ RESPONDE
--
--   "De las categorías / variedades / SKUs que esta cuenta efectivamente vendió
--    (o compró), ¿cuántas tocaron alguna vez un canal online?"
--
-- Y por diferencia, cuántas NUNCA lo tocaron: el gap accionable.
--
-- ----------------------------------------------------------------------------
-- POR QUÉ NO SE COPIA EL CÁLCULO DEL DASHBOARD LEGACY  ← lo importante
--
-- El v3 calcula el gap como `offline_skus − online_skus`. Eso es una RESTA DE
-- CONTEOS, no una diferencia de conjuntos, y los dos conjuntos se solapan casi
-- siempre: un SKU vendido por los dos canales se cuenta de los dos lados y se
-- cancela. De 155 cuentas que venden por ambos canales, solo 6 tienen conjuntos
-- disjuntos.
--
-- Medido sobre skus_online_offline.json (el archivo que alimenta esa tabla):
--   · 141 de 330 cuentas tienen gap NEGATIVO. "−990" no significa nada.
--   · 250 de 330 no coinciden con el gap real.
--   · Red: 70.062 publicado contra 167.031 real. Subestimado 2,4x.
--   · Sims Flower Distribution figura con 34; el real es 1.155.
--
-- Acá el gap es `total − online`, que sí es un conjunto. Sale de comparar
-- COUNT(DISTINCT x) contra COUNT(DISTINCT CASE WHEN canal online THEN x END),
-- sin restar conteos que se pisan.
--
-- La otra diferencia: el legacy cuenta categorías sobre el top-20 de
-- categories_top20, no sobre el universo. Mayesh tiene 581, no 20.
--
-- ----------------------------------------------------------------------------
-- VENTANA FIJA, A PROPÓSITO
--
-- 12 meses cerrados (2025-09..2026-08), no el selector de período. La amplitud
-- de catálogo es estructural: una ventana más corta muestra menos categorías
-- por definición, así que comparar H1 contra YTD mediría el largo de la ventana
-- y no un cambio de comportamiento — inventaría una "caída de catálogo".
-- Se etiqueta con su ventana en la tarjeta, como los demás archivos-foto.
--
-- ----------------------------------------------------------------------------
-- MIDE LO VENDIDO/COMPRADO, NO LO PUBLICADO
--
-- Una variedad listada online que no se vendió cuenta acá como no-online. Para
-- "qué tiene disponible" haría falta INVENTORY_DETAILS, que no tiene vista
-- semántica (ver inventory_current.sql) y además no confirma visibilidad real
-- en el eShop.
--
-- Consumido por: buildSell()/buildBuy() → catalog_reach → tarjetas SELL y BUY.
-- ============================================================================

-- ── 1. VENTA ────────────────────────────────────────────────────────────────
-- Online (Regla 6) = eCommerce + K2K + API. Todo lo demás es offline.
-- R4 va por línea (sales < 100000), nunca en un HAVING: en HAVING dejaría
-- afuera a toda empresa que supere los $100K, que es justo lo contrario.
SELECT *
FROM SEMANTIC_VIEW(
  PRODUCTION.ANALYTICS.SALES_SV
  METRICS
    COUNT(DISTINCT sale_details.product_category_name) AS cat_total,
    COUNT(DISTINCT CASE WHEN sale_details.sales_channel IN ('eCommerce', 'K2K', 'API')
                        THEN sale_details.product_category_name END) AS cat_online,
    COUNT(DISTINCT sale_details.product_variety) AS var_total,
    COUNT(DISTINCT CASE WHEN sale_details.sales_channel IN ('eCommerce', 'K2K', 'API')
                        THEN sale_details.product_variety END) AS var_online,
    COUNT(DISTINCT sale_details.product_description) AS sku_total,
    COUNT(DISTINCT CASE WHEN sale_details.sales_channel IN ('eCommerce', 'K2K', 'API')
                        THEN sale_details.product_description END) AS sku_online
  DIMENSIONS companies.company_id
  WHERE companies.ks_flag = TRUE                    -- R1
    AND sale_details.shipping_date >= '2025-09-01'
    AND sale_details.shipping_date <  '2026-09-01'
    AND sale_details.sales < 100000                 -- R4, por línea
);

-- ── 2. COMPRA ───────────────────────────────────────────────────────────────
-- Online en compra = Web + Procurement + API; offline = Unknown + N/A.
-- Verificado contra los valores reales del campo (2026, ks_flag=TRUE):
--   Unknown 5.174.730 líneas · Procurement 238.857 · Web 177.578 · N/A 36.972 · API 6.318
-- Coincide con el hallazgo 7 de la validación de datos. La hipótesis vieja
-- (solo 'Procurement') dejaba afuera Web, que es el grueso del online.
SELECT *
FROM SEMANTIC_VIEW(
  PRODUCTION.ANALYTICS.PROCUREMENTS_SV
  METRICS
    COUNT(DISTINCT procurement_details.product_category_name) AS cat_total,
    COUNT(DISTINCT CASE WHEN procurement_details.sales_channel IN ('Web', 'Procurement', 'API')
                        THEN procurement_details.product_category_name END) AS cat_online,
    COUNT(DISTINCT procurement_details.product_variety) AS var_total,
    COUNT(DISTINCT CASE WHEN procurement_details.sales_channel IN ('Web', 'Procurement', 'API')
                        THEN procurement_details.product_variety END) AS var_online,
    COUNT(DISTINCT procurement_details.product_description) AS sku_total,
    COUNT(DISTINCT CASE WHEN procurement_details.sales_channel IN ('Web', 'Procurement', 'API')
                        THEN procurement_details.product_description END) AS sku_online
  DIMENSIONS procurement_details.company_id
  WHERE procurement_details.shipping_date >= '2025-09-01'
    AND procurement_details.shipping_date <  '2026-09-01'
    AND companies.ks_flag = TRUE
);

-- ============================================================================
-- ⭐ LAS QUE HAY QUE CORRER — código canónico y los cuatro períodos
--
-- POR QUÉ POR PERÍODO Y NO UNA VENTANA FIJA
--
-- La primera versión de esto usaba una sola ventana de 12 meses, con el
-- argumento de que el ancho de catálogo depende del largo de la ventana y por
-- lo tanto comparar H1 contra YTD mide la ventana y no la cuenta.
--
-- Eso vale para los CONTEOS ABSOLUTOS y sigue valiendo. Pero la conclusión era
-- de más, por dos razones:
--
--   · La COBERTURA % es un ratio dentro de la misma ventana. "En H1 vendió 300
--     categorías, 180 online = 60%" es una afirmación válida sobre H1: el largo
--     de la ventana afecta numerador y denominador por igual.
--   · `prev_year` (todo 2025) y `l12m` (sep 2025–ago 2026) miden los dos 12
--     meses. Esos dos son comparables en todo, conteos incluidos, y ahí hay una
--     lectura de evolución de catálogo que la ventana fija tiraba.
--
-- Así que se extraen los cuatro períodos y la tarjeta sigue el selector como el
-- resto del dashboard. Lo que NO se puede comparar —conteos absolutos entre
-- ventanas de distinto largo— se resuelve etiquetando el período, no
-- escondiéndolo. Una excepción a cómo se comporta todo lo demás cuesta más de
-- lo que parece.
--
-- Los cuatro períodos son los de src/data/adapter/period.ts, ancladas en
-- 2026-08 (último mes cerrado del cubo de sell). Si el ancla cambia, cambian
-- las fechas de acá.
--
-- SOBRE EL CÓDIGO CANÓNICO: `product_category_name` es texto libre por empresa
-- (3.997 nombres, 2.739 de ellos de una sola empresa; Rose/Roses/ROSE/ROSES son
-- cuatro). PRODUCTS.category_network_code_id es la taxonomía de red — 1274 =
-- "Rosa" agrupa todas sus variantes. Ni SALES_SV ni PROCUREMENTS_SV lo exponen,
-- pero las dos tienen product_id, así que el join está disponible al precio de
-- salir del alcance del MCP de Cortex: estas van a mano o por el pipeline.
--
--   python3 scripts/rebuild_catalog_reach.py --sell venta.json --buy compra.json \
--                                            --category-key network_code
--
-- NOTA: `product_variety` y `product_description` también son texto libre y
-- arrastran el mismo problema. No se midió cuánto.
-- ============================================================================

-- ── 5. VENTA: código canónico × los cuatro períodos ─────────────────────
WITH base AS (
    SELECT
        sd.company_id,
        p.category_network_code_id,
        sd.product_variety,
        sd.product_description,
        sd.sales_channel,
        sd.shipping_date >= '2026-01-01' AND sd.shipping_date < '2026-09-01' AS ytd_win,   -- ene–ago 2026
        sd.shipping_date >= '2026-01-01' AND sd.shipping_date < '2026-07-01' AS h1_win,   -- ene–jun 2026
        sd.shipping_date >= '2025-01-01' AND sd.shipping_date < '2026-01-01' AS prev_year_win,   -- todo 2025
        sd.shipping_date >= '2025-09-01' AND sd.shipping_date < '2026-09-01' AS l12m_win    -- sep 2025–ago 2026
    FROM PRODUCTION.ANALYTICS.SALE_DETAILS sd
    JOIN PRODUCTION.ANALYTICS.PRODUCTS  p ON p.product_id = sd.product_id
    JOIN PRODUCTION.ANALYTICS.COMPANIES c ON c.company_id = sd.company_id
    WHERE c.ks_flag = TRUE                       -- R1
      AND sd.sales < 100000                   -- R4, por línea
      AND sd.shipping_date >= '2025-01-01'    -- cubre prev_year, el más viejo
      AND sd.shipping_date <  '2026-09-01'
)
SELECT
    company_id,
    COUNT(DISTINCT CASE WHEN ytd_win THEN category_network_code_id END) AS cat_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN category_network_code_id END) AS cat_online_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win THEN product_variety END) AS var_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_variety END) AS var_online_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win THEN product_description END) AS sku_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_description END) AS sku_online_ytd,
    COUNT(DISTINCT CASE WHEN h1_win THEN category_network_code_id END) AS cat_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN category_network_code_id END) AS cat_online_h1,
    COUNT(DISTINCT CASE WHEN h1_win THEN product_variety END) AS var_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_variety END) AS var_online_h1,
    COUNT(DISTINCT CASE WHEN h1_win THEN product_description END) AS sku_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_description END) AS sku_online_h1,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN category_network_code_id END) AS cat_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN category_network_code_id END) AS cat_online_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN product_variety END) AS var_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_variety END) AS var_online_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN product_description END) AS sku_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_description END) AS sku_online_prev_year,
    COUNT(DISTINCT CASE WHEN l12m_win THEN category_network_code_id END) AS cat_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN category_network_code_id END) AS cat_online_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win THEN product_variety END) AS var_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_variety END) AS var_online_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win THEN product_description END) AS sku_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('eCommerce', 'K2K', 'API') THEN product_description END) AS sku_online_l12m
FROM base
GROUP BY company_id;

-- ── 6. COMPRA: código canónico × los cuatro períodos ─────────────────────
WITH base AS (
    SELECT
        pd.company_id,
        p.category_network_code_id,
        pd.product_variety,
        pd.product_description,
        pd.sales_channel,
        pd.shipping_date >= '2026-01-01' AND pd.shipping_date < '2026-09-01' AS ytd_win,   -- ene–ago 2026
        pd.shipping_date >= '2026-01-01' AND pd.shipping_date < '2026-07-01' AS h1_win,   -- ene–jun 2026
        pd.shipping_date >= '2025-01-01' AND pd.shipping_date < '2026-01-01' AS prev_year_win,   -- todo 2025
        pd.shipping_date >= '2025-09-01' AND pd.shipping_date < '2026-09-01' AS l12m_win    -- sep 2025–ago 2026
    FROM PRODUCTION.ANALYTICS.PROCUREMENT_DETAILS pd
    JOIN PRODUCTION.ANALYTICS.PRODUCTS  p ON p.product_id = pd.product_id
    JOIN PRODUCTION.ANALYTICS.COMPANIES c ON c.company_id = pd.company_id
    WHERE c.ks_flag = TRUE                       -- R1
      AND pd.shipping_date >= '2025-01-01'    -- cubre prev_year, el más viejo
      AND pd.shipping_date <  '2026-09-01'
)
SELECT
    company_id,
    COUNT(DISTINCT CASE WHEN ytd_win THEN category_network_code_id END) AS cat_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN category_network_code_id END) AS cat_online_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win THEN product_variety END) AS var_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_variety END) AS var_online_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win THEN product_description END) AS sku_total_ytd,
    COUNT(DISTINCT CASE WHEN ytd_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_description END) AS sku_online_ytd,
    COUNT(DISTINCT CASE WHEN h1_win THEN category_network_code_id END) AS cat_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN category_network_code_id END) AS cat_online_h1,
    COUNT(DISTINCT CASE WHEN h1_win THEN product_variety END) AS var_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_variety END) AS var_online_h1,
    COUNT(DISTINCT CASE WHEN h1_win THEN product_description END) AS sku_total_h1,
    COUNT(DISTINCT CASE WHEN h1_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_description END) AS sku_online_h1,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN category_network_code_id END) AS cat_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN category_network_code_id END) AS cat_online_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN product_variety END) AS var_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_variety END) AS var_online_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win THEN product_description END) AS sku_total_prev_year,
    COUNT(DISTINCT CASE WHEN prev_year_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_description END) AS sku_online_prev_year,
    COUNT(DISTINCT CASE WHEN l12m_win THEN category_network_code_id END) AS cat_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN category_network_code_id END) AS cat_online_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win THEN product_variety END) AS var_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_variety END) AS var_online_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win THEN product_description END) AS sku_total_l12m,
    COUNT(DISTINCT CASE WHEN l12m_win AND sales_channel IN ('Web', 'Procurement', 'API') THEN product_description END) AS sku_online_l12m
FROM base
GROUP BY company_id;
