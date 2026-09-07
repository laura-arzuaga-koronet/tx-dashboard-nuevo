-- ============================================================================
-- Manual / curated data that has NO system of record in Snowflake or Salesforce.
-- Target: Supabase (Postgres). These replace the hand-maintained parts of the
-- legacy JSON files and make them editable with history instead of regenerated.
-- ============================================================================

-- 1. Per-account overrides — the "Christine cascade" and human prioritization
--    that today live inside accounts_v3.json. One row per company; the app
--    merges these ON TOP of the system view (sql/salesforce/accounts_system_fields.soql).
CREATE TABLE IF NOT EXISTS tx_account_overrides (
    company_id          text PRIMARY KEY,            -- Koronet company id, or 'sfdc:<AccountId>' for prospects
    sfdc_id             text,
    gmv_reference       numeric,                     -- annual sell GMV reference (USD)
    gmv_source          text CHECK (gmv_source IN (
                            'Medido', 'Estimado', 'Estimado (verificar)', 'Estimado (AnnualRevenue×0.11)',
                            'ORA', 'FCS', 'Piso de red', 'Piso (solo K2K)', 'No vende (Koronet)', 'Sin dato')),
    gmv_is_floor        boolean NOT NULL DEFAULT false,
    in_christine_sheet  boolean NOT NULL DEFAULT false,
    potential_tier      text CHECK (potential_tier IN ('Flagship', 'Growth Engine', 'Activate', 'Seed', 'Unmeasured')),
    priority_level      text,                        -- P1 · IMPL · TA · CS_TRACKED · CS_P2 · WATCH · NEEDS_REVIEW · ECOSYSTEM · PIPELINE · PARKED
    archetype           text,
    archetype_name      text,
    prospect_reason     text,
    digital_pct_caveat  text,                        -- e.g. 'solo_digital_visible'
    notes               text,
    updated_by          text,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Audit trail so a changed GMV estimate is never silently overwritten.
CREATE TABLE IF NOT EXISTS tx_account_overrides_history (
    id            bigserial PRIMARY KEY,
    company_id    text NOT NULL,
    snapshot      jsonb NOT NULL,                    -- full previous row
    changed_by    text,
    changed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION tx_account_overrides_audit() RETURNS trigger AS $$
BEGIN
    INSERT INTO tx_account_overrides_history (company_id, snapshot, changed_by)
    VALUES (OLD.company_id, to_jsonb(OLD), NEW.updated_by);
    NEW.updated_at := now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tx_account_overrides_audit ON tx_account_overrides;
CREATE TRIGGER trg_tx_account_overrides_audit
    BEFORE UPDATE ON tx_account_overrides
    FOR EACH ROW EXECUTE FUNCTION tx_account_overrides_audit();

-- 2. External GMV research — today public/data/gmv_estimates_external.json (109 accounts).
CREATE TABLE IF NOT EXISTS tx_gmv_estimates_external (
    company_id          text PRIMARY KEY,
    business_type       text,
    methods_used        text[],                      -- e.g. {'headcount: 5-9 emp x $375K','aggregator floor: $1M x4'}
    estimated_gmv_low   numeric,
    estimated_gmv_mid   numeric,                     -- ← the value the adapter reads
    estimated_gmv_high  numeric,
    confidence          text,                        -- Low · Medium · High
    signals             jsonb,                       -- {locations, employees, website, metro}
    notes               text,
    researched_at       date,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 3. Excluded company ids (training / sandbox / demo) — today hardcoded in
--    src/data/adapter/files.ts (12 ids) and refresh_queries.md (14 KP ids).
CREATE TABLE IF NOT EXISTS tx_excluded_company_ids (
    company_id  text PRIMARY KEY,
    scope       text NOT NULL CHECK (scope IN ('all', 'procurement')),
    reason      text
);

INSERT INTO tx_excluded_company_ids (company_id, scope, reason) VALUES
    ('561353','all','training/demo'), ('549016','all','training/demo'), ('6316','all','training/demo'),
    ('554582','all','training/demo'), ('531246','all','training/demo'), ('531265','all','training/demo'),
    ('55326','all','training/demo'),  ('751276','all','training/demo'), ('132431','all','training/demo'),
    ('468006','all','training/demo'), ('398804','all','training/demo'), ('806094','all','training/demo'),
    ('13804','procurement','internal KP'),  ('256252','procurement','internal KP'), ('469537','procurement','internal KP'),
    ('376170','procurement','internal KP'), ('581383','procurement','internal KP'), ('644249','procurement','internal KP'),
    ('666205','procurement','internal KP'), ('730096','procurement','internal KP'), ('726492','procurement','internal KP'),
    ('677351','procurement','internal KP'), ('101905','procurement','internal KP'), ('768945','procurement','internal KP')
ON CONFLICT (company_id) DO NOTHING;
