-- ============================================================================
-- fees_monthly  →  replaces public/data/current/fees_monthly.json
-- Grain : company × month × fee_channel
-- Source: PRODUCTION.ANALYTICS.CONSOLIDATED_TRANSACTION_FEES (billed + projected)
-- Origin: tx-dashboards/data/current/refresh_queries.md (Cube 3)
-- Status: READY
-- ----------------------------------------------------------------------------
-- Rules applied:
--   R1  ks_flag = TRUE
--   status = 'Billed' (legacy _meta: "ks_flag=TRUE, status=Billed")
--   fee_channel IN ('eCommerce','K2K','API') → FedEx / Gross Profit Share excluded,
--   matching the legacy cube (ecom / k2k / api only)
--   company_id is TEXT here (NUMBER in SALE_DETAILS) — cast when joining
--   KP billing is NOT in this table (subscription/threshold based)
--
-- Output uses the normalized labels the adapter expects (ecom / k2k / api).
--
-- IMPORTANT — shape change vs. the legacy JSON:
-- the legacy file stores prior-year fees as ONE row per company with
-- month='2025-01', fee_channel='total'. The adapter sums every row per company
-- without filtering by month, so fees_ytd_2026 currently INCLUDES the 2025
-- total (see sql/README.md → Hallazgos). This query returns true monthly grain
-- for the whole window; the adapter must filter by year when it consumes it.
-- ============================================================================
SELECT
    company_id,
    company_name,
    DATE_TRUNC('month', transaction_date)::DATE           AS month,
    CASE fee_channel
        WHEN 'eCommerce' THEN 'ecom'
        WHEN 'K2K'       THEN 'k2k'
        WHEN 'API'       THEN 'api'
    END                                                   AS fee_channel,
    SUM(fee_amount)                                       AS fee_amount
FROM PRODUCTION.ANALYTICS.CONSOLIDATED_TRANSACTION_FEES
WHERE ks_flag = TRUE
  AND status = 'Billed'
  AND fee_channel IN ('eCommerce', 'K2K', 'API')
  AND transaction_date >= DATE_TRUNC('year', DATEADD('year', -1, CURRENT_DATE))   -- prior year + current YTD
GROUP BY 1, 2, 3, 4
ORDER BY company_id, month, fee_channel;
