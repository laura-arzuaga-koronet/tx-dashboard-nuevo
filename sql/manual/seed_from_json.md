# Cargar los datos manuales desde los JSON actuales

Una sola vez, para no perder lo que ya está curado:

| Tabla | Origen | Cómo |
|---|---|---|
| `tx_account_overrides` | `public/data/accounts_v3.json` → campos `gmv_reference`, `gmv_source`, `gmv_is_floor`, `in_christine_sheet`, `potential_tier`, `priority_level`, `archetype`, `archetype_name`, `prospect_reason`, `digital_pct_caveat` | Filtrar a cuentas donde alguno de esos campos no sea vacío (~600 de 4.026). Llave: `company_id`, o `sfdc:<sfdc_id>` cuando no hay id Koronet (misma regla que `store.ts`). |
| `tx_gmv_estimates_external` | `public/data/gmv_estimates_external.json` → `estimates[]` | Mapeo 1:1 de campos. |
| `tx_excluded_company_ids` | ya viene en `schema.sql` | — |

Nota sobre `gmv_source`: `Medido` y `Piso de red` NO deberían guardarse como override — el adapter los deriva del cubo de sell. Solo persistir las filas cuyo `gmv_source` sea `Estimado*`, `ORA`, `FCS`, `No vende (Koronet)` o `Sin dato`.
