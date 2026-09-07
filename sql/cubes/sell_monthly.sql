-- ============================================================================
-- sell_monthly  →  replaces public/data/current/sell_monthly.json
-- Grain : company × month × channel
-- Source: PRODUCTION.ANALYTICS.SALE_DETAILS
-- Origin: tx-dashboards/data/current/refresh_queries.md (Cube 1), full-window form
-- Status: READY (verified query from the legacy repo)
-- ----------------------------------------------------------------------------
-- Rules applied (see sql/README.md → Reglas):
--   R1  ks_flag = TRUE
--   Invoice+Confirmed OR Prebook (never Invoice-only — drops eSuite prebooks)
--   SALE_STATUS is case-sensitive ('Confirmed')
--   shipping_date drives the month bucket
--
-- Channel normalization: the legacy cube mixes two generations of labels
-- (2024-08..2025-07 → eCommerce/K2K/API/Offline; 2025-08..2026-07 → Online/Offline).
-- The adapter treats ONLY 'Online' as online (helpers.ts → aggregateSellCube).
-- This query emits the raw channel AND a normalized `channel_group` so the
-- consumer can choose. Decide before go-live whether K2K/API count as online
-- (Rule 6 in the V2 files says online = eCommerce + K2K + API).
-- ============================================================================
SELECT
    company_id,
    company_name,
    DATE_TRUNC('month', shipping_date)::DATE                              AS month,
    sales_channel                                                         AS channel,
    CASE WHEN sales_channel IN ('eCommerce', 'K2K', 'API') THEN 'Online'
         ELSE 'Offline' END                                               AS channel_group,
    SUM(sales)                                                            AS sell_gmv,
    COUNT(DISTINCT sale_number)                                           AS order_count
FROM PRODUCTION.ANALYTICS.SALE_DETAILS
WHERE ks_flag = TRUE
  AND shipping_date >= DATEADD('month', -24, DATE_TRUNC('month', CURRENT_DATE))
  AND shipping_date <  DATE_TRUNC('month', CURRENT_DATE)          -- last closed month
  AND (
        (sale_order_type = 'Invoice' AND sale_status = 'Confirmed')
     OR  sale_order_type = 'Prebook'
  )
GROUP BY 1, 2, 3, 4, 5
ORDER BY company_id, month, channel;
