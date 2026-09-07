-- ============================================================================
-- fees_monthly  →  replaces public/data/current/fees_monthly.json
-- Grain : company × month × fee_channel
-- Source: PRODUCTION.ANALYTICS.TRANSACTION_FEES (billed) — the query actually run on
--         2026-09-07 to regenerate public/data/current/fees_monthly.json (via Cortex
--         Analyst + sql_exec_tool, one month per call to stay under the partition limit).
--         CONSOLIDATED_TRANSACTION_FEES (billed + projected) has no Cortex semantic
--         model yet; switch to it when current-month projections are wanted.
-- Origin: tx-dashboards/data/current/refresh_queries.md (Cube 3)
-- Status: READY · EXECUTED
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
-- Date basis: transaction_date (when the fee was earned). bill_date runs one
-- month later because fees are billed in arrears — do NOT mix the two.
--
-- Shape change vs. the legacy JSON: the legacy stored prior-year fees as ONE
-- row per company (month='2025-01', fee_channel='total'); this returns true
-- monthly grain and the adapter filters by period (see sql/README.md → Hallazgos 1).
-- ============================================================================
SELECT
    company_id,
    company_name,
    DATE_TRUNC('month', transaction_date)::DATE           AS month,
    CASE transaction_type
        WHEN 'eCommerce' THEN 'ecom'
        WHEN 'K2K'       THEN 'k2k'
        WHEN 'API'       THEN 'api'
    END                                                   AS fee_channel,
    SUM(fee_amount)                                       AS fee_amount
FROM PRODUCTION.ANALYTICS.TRANSACTION_FEES
WHERE ks_flag = TRUE
  AND transaction_type IN ('eCommerce', 'K2K', 'API')          -- FedEx, Gross Profit Share excluded (legacy behaviour)
  AND transaction_date >= DATE_TRUNC('year', DATEADD('year', -1, CURRENT_DATE))   -- prior year + current YTD
GROUP BY 1, 2, 3, 4
ORDER BY company_id, month, fee_channel;

-- Month-chunked form used for the extraction (Cortex Analyst pagination-safe):
--   ... WHERE ks_flag = TRUE AND transaction_date >= :start AND transaction_date < :end ...
