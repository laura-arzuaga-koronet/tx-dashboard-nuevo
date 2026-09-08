-- ============================================================================
-- buy_monthly  →  replaces public/data/current/buy_monthly.json
-- Grain : company × month
-- Source: PRODUCTION.ANALYTICS.PROCUREMENT_DETAILS  (Koronet Procurement, not eCommerce)
-- Origin: tx-dashboards/data/current/refresh_queries.md (Cube 2)
-- Status: READY · SPLIT VALIDATED against Snowflake on 2026-09-08
-- ----------------------------------------------------------------------------
-- Rules applied:
--   R1  ks_flag = TRUE
--   Revenue field is total_cost (NOT sales)
--   14-ID internal exclusion when joining COMPANIES (see sql/manual/schema.sql)
--   shipping_date drives the month bucket
--
-- ONLINE/OFFLINE SPLIT — validated, and NOT what refresh_queries.md guessed.
-- PROCUREMENT_DETAILS.sales_channel has five values; the cube's split is:
--     online  = Web + Procurement + API
--     offline = Unknown + N/A
-- Verified for Jan–Jul 2026 against the cube (generated 2026-08-13):
--     online   Snowflake  31,483,568  vs cube  31,480,451   (0.01%)
--     offline  Snowflake 513,068,030  vs cube 512,878,435   (0.04%)
-- Two consequences:
--   1. refresh_queries.md says `sales_channel = 'Procurement'` is mandatory. That
--      is WRONG for this cube: Procurement alone is only $19.3M of the $544M the
--      cube reports for Jan–Jul 2026. Do NOT add that filter.
--   2. 'Web' is a real online channel here ($11.8M Jan–Jul 2026) — dropping it
--      would understate buy_online_pct by roughly a third.
-- ============================================================================
SELECT
    pd.company_id,
    pd.company_name,
    DATE_TRUNC('month', pd.shipping_date)::DATE                                            AS month,
    SUM(pd.total_cost)                                                                     AS buy_gmv,
    SUM(CASE WHEN pd.sales_channel IN ('Web', 'Procurement', 'API') THEN pd.total_cost ELSE 0 END) AS buy_online,
    SUM(CASE WHEN pd.sales_channel IN ('Unknown', 'N/A')            THEN pd.total_cost ELSE 0 END) AS buy_offline,
    COUNT(DISTINCT pd.purchase_order_number)                                               AS po_count
FROM PRODUCTION.ANALYTICS.PROCUREMENT_DETAILS pd
WHERE pd.ks_flag = TRUE
  AND pd.shipping_date >= DATEADD('month', -24, DATE_TRUNC('month', CURRENT_DATE))
  AND pd.shipping_date <  DATE_TRUNC('month', CURRENT_DATE)
GROUP BY 1, 2, 3
ORDER BY company_id, month;
