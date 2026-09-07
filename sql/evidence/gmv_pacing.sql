-- ============================================================================
-- gmv_pacing  →  replaces public/data/gmv_pacing.json
-- Status: DERIVED — computable from sell_monthly + accounts.
-- ----------------------------------------------------------------------------
-- Fields in the legacy file: total_sell_observed, months_observed, days_observed,
-- daily_rate, annual_pace, confidence, gmv_reference, gmv_source, pace_vs_ref.
--
--   total_sell_observed = SUM(sell_gmv) over last 12 closed months
--   months_observed     = COUNT(DISTINCT month)
--   days_observed       = months_observed * 30
--   daily_rate          = total_sell_observed / days_observed
--   annual_pace         = daily_rate * 365
--   confidence          = 'Alta' when days_observed >= 240 else 'Media'/'Baja'
--   pace_vs_ref         = annual_pace / gmv_reference * 100
--
-- Can be a CTE over sql/cubes/sell_monthly.sql. Only gmv_pace / days_observed
-- are consumed by the adapter (buildPotential); the rest is informational.
-- ============================================================================
WITH sell AS (
    SELECT company_id, month, SUM(sell_gmv) AS sell_gmv
    FROM   tx_sell_monthly                       -- output of sql/cubes/sell_monthly.sql
    WHERE  month >= DATEADD('month', -12, DATE_TRUNC('month', CURRENT_DATE))
    GROUP BY 1, 2
)
SELECT
    company_id,
    SUM(sell_gmv)                                 AS total_sell_observed,
    COUNT(DISTINCT month)                         AS months_observed,
    COUNT(DISTINCT month) * 30                    AS days_observed,
    SUM(sell_gmv) / (COUNT(DISTINCT month) * 30)  AS daily_rate,
    SUM(sell_gmv) / (COUNT(DISTINCT month) * 30) * 365 AS annual_pace,
    CASE WHEN COUNT(DISTINCT month) * 30 >= 240 THEN 'Alta'
         WHEN COUNT(DISTINCT month) * 30 >= 120 THEN 'Media'
         ELSE 'Baja' END                          AS confidence
FROM sell
GROUP BY 1;
