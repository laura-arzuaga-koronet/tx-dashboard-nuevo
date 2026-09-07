-- ============================================================================
-- buy_monthly  →  replaces public/data/current/buy_monthly.json
-- Grain : company × month
-- Source: PRODUCTION.ANALYTICS.PROCUREMENT_DETAILS  (Koronet Procurement, not eCommerce)
-- Origin: tx-dashboards/data/current/refresh_queries.md (Cube 2)
-- Status: READY with one OPEN QUESTION (buy_online / buy_offline split)
-- ----------------------------------------------------------------------------
-- Rules applied:
--   R1  ks_flag = TRUE
--   sales_channel = 'Procurement' scopes to KP (other channels exist on the table)
--   Revenue field is total_cost (NOT sales)
--   14-ID internal exclusion when joining COMPANIES (see sql/manual/excluded_ids.sql)
--   shipping_date drives the month bucket
--
-- OPEN: the legacy cube carries buy_online / buy_offline (1,601 of 3,993 rows
-- have buy_online > 0). PROCUREMENT_DETAILS has no native online flag; the
-- CASE below (Procurement = online, else offline) is the hypothesis documented
-- in refresh_queries.md. Confirm against the query in the "TX fees action plan"
-- chat before trusting buy_online_pct.
-- ============================================================================
SELECT
    pd.company_id,
    pd.company_name,
    DATE_TRUNC('month', pd.shipping_date)::DATE                                            AS month,
    SUM(pd.total_cost)                                                                     AS buy_gmv,
    SUM(CASE WHEN pd.sales_channel =  'Procurement' THEN pd.total_cost ELSE 0 END)         AS buy_online,
    SUM(CASE WHEN pd.sales_channel <> 'Procurement' THEN pd.total_cost ELSE 0 END)         AS buy_offline,
    COUNT(DISTINCT pd.purchase_order_number)                                               AS po_count
FROM PRODUCTION.ANALYTICS.PROCUREMENT_DETAILS pd
WHERE pd.ks_flag = TRUE
  AND pd.shipping_date >= DATEADD('month', -24, DATE_TRUNC('month', CURRENT_DATE))
  AND pd.shipping_date <  DATE_TRUNC('month', CURRENT_DATE)
GROUP BY 1, 2, 3
ORDER BY company_id, month;
