-- companies_universe.sql → public/data/companies_universe_v1.json
--
-- El universo de companies de Koronet tal como lo ve Snowflake, con los campos
-- que deciden si una cuenta es cliente y el Annual Total Sales que sirve de
-- último recurso para el Est GMV.
--
-- Generado por Cortex Analyst sobre COMPANIES_SV (request_id
-- 1319e215-b856-4585-b225-96a9fca24767). R1: ks_flag = TRUE excluye demos.
--
-- Lo consume scripts/rebuild_companies_universe.py, que corre ANTES de
-- rebuild_accounts_gmv.py para que las cuentas nuevas pasen por la cascada.
WITH __companies AS (
  SELECT
    account_id,
    company_id,
    company_industry,
    company_name,
    komet_account_type,
    komet_status,
    ks_flag,
    record_type_name,
    annual_total_sales
  FROM PRODUCTION.ANALYTICS.COMPANIES
)
SELECT
  company_id,
  account_id,
  company_name,
  company_industry,
  komet_status,
  record_type_name,
  komet_account_type,
  annual_total_sales
FROM __companies
WHERE
  ks_flag = TRUE
ORDER BY
  company_id;
