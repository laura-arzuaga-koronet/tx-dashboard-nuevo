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
-- CÓMO ARMAR EL JSON
--
--   python3 scripts/rebuild_catalog_reach.py --sell venta.json --buy compra.json
--
-- El script calcula offline_only y coverage_pct por dimensión, y los percentiles
-- de cobertura de toda la red para poder comparar cada cuenta contra la mediana.
--
-- Los percentiles se calculan solo sobre cuentas con 10+ ítems en esa dimensión:
-- una finca con 1 categoría vendida online da 100% y arrastra la mediana.
--
-- Referencia de la corrida 2026-09-10 (mediana de cobertura, red):
--   venta   categorías 87,9% · variedades 62,8% · SKUs 55,2%
--   compra  categorías 51,1% · variedades  2,3% · SKUs  0,4%
--
-- El p90 da 100% en las seis: la distribución es BIMODAL — o la cuenta tiene
-- todo online o no tiene nada. Por eso la tarjeta compara contra la mediana y
-- no contra el p90: el techo no discrimina.
-- ============================================================================
