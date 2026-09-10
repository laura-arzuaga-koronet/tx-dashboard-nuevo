# TX Dashboard · Revenue OS (React + TypeScript + Vite)

Migración de `tx-dashboards/tx-dashboard-v3.html` (un HTML monolítico de ~4.500 líneas) a una
aplicación React + TypeScript construida con Vite. La migración fue **secuencial** y ya cubre toda
la funcionalidad del original, con la lógica de negocio separada de la UI, el adapter de datos
tipado y un test de paridad que compara campo por campo contra el adapter legacy.

## Estado de la migración

| Fase | Alcance | Estado |
|---|---|---|
| **1 · Base** | Estructura del proyecto, tokens de estilo, adapter en TS con test de paridad, topbar con filtros, KPI strip, tabs, tabla de portafolio con sort/paginación, fila expandible | ✅ |
| **1b · Períodos** | Modelo `Period` con rangos explícitos y baseline YoY like-for-like; fees filtrados por período (corrige el KPI inflado del legacy) | ✅ |
| **1c · Paridad con el legacy corregido** | Los cuatro períodos; Direct/Indirect Fees y el nuevo Take Rate; tendencia en todas las columnas métricas; motivo por celda cuando una métrica está vacía; universo de wholesalers + tab del 618; exclusión de datos corruptos; auto-ventas separadas del sell GMV | ✅ |
| **2 · Tarjetas** | Las 6 tarjetas de evidencia (Potential, Opportunities, BUY, LIST, SELL, Data coverage) dentro de la fila expandida | ✅ |
| **3 · Definitions & Matrix** | Matriz Est GMV × Product Tier con drill-down a la tabla, y las tablas de metodología con las fórmulas nuevas | ✅ |
| **3b · Correcciones de medición** | Est GMV prorrateado al período; verificación del "Medido" contra el cubo; tautología de compra desacoplada de la de venta; alcance online del catálogo con el gap bien calculado; los seis motivos del cero de venta | ✅ |
| **3c · Re-extracción de fuentes** | Las 7 fuentes de evidencia al día, con `generated_at` en todas y scripts de reconstrucción versionados | ✅ |
| 4 · Datos | Compactar los 20 JSON (~15,5 MB) en un bundle por vista; derivar el período desde `_meta` en todos lados | Pendiente |

## Cómo correrlo

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + lint + tests + build — lo mismo que corre CI
```

`npm run check` es la puerta antes de cualquier commit. **`npx tsc --noEmit` no alcanza**: usa el
tsconfig raíz, que no chequea `src`. El typecheck real es `tsc -p tsconfig.app.json --noEmit`, y
ni Vitest ni ESLint hacen type-checking, así que se puede tener 33 tests en verde y el CI roto.

## Estructura de carpetas

```
public/
  data/                     20 JSON de evidencia (~15,5 MB), leídos directo por el navegador
    current/                cubos mensuales sell / buy / fees / indirect + fee_rates + _manifest
scripts/                    Reconstrucción de los JSON desde Snowflake (ver "Refrescar los datos")
src/
  app/                      App shell (hoy una sola vista; acá entra el router cuando haya más páginas)
  styles/
    tokens.css              Variables de diseño (colores, tipografía, radios, sombras, layout)
    global.css              Reset + utilidades mínimas, incluidas las clases .ev-state
  components/ui/            Primitivas reutilizables sin lógica de negocio
    SelectPill, TabButton/TabsNav, Chip (RemovableChip/ToggleChip), Badge, Sparkline, Spinner
  data/
    adapter/                Evidence Adapter — la capa de datos
      files.ts              Registro de los 18 archivos + fetch tolerante a fallos + IDs excluidos
      period.ts             Modelo Period: ytd / h1 / prev_year / l12m anclados al último mes cerrado
      types.ts              Tipos raw (shape de los JSON) y de dominio (AccountEvidence)
      helpers.ts            Agregaciones puras de cubos, deltas, meses
      store.ts              Carga en paralelo, índices por company_id, benchmark de frescura
      builders.ts           Reglas de negocio: Piso de red, penetración, take rate, catalog reach
      index.ts              API pública (init, getAccountEvidence, getAllAccountIds, …)
    sfdc/openOpportunities.ts   Oportunidades abiertas de Salesforce → "$ at Stake"
  domain/                   Lógica pura sobre AccountEvidence (sin React, sin DOM)
    format.ts               fmtMoney, fmtPct, evValue, gmvSourceLabel (traduce la cascada al inglés)
    metrics.ts              $ at stake, diagnosis, opportunity flags, sparkline, GMV bands
    thresholds.ts           Umbrales → tono/qualifier de cada celda (una sola fuente de verdad)
    filters.ts              Modelo de filtros + applyFilters + conteos de tabs
    sort.ts / kpis.ts       Sort por columna · KPIs del portafolio
    period.ts               Helpers de UI sobre el modelo Period del adapter
  state/filtersReducer.ts   Reducer de filtros (incluye las interacciones cruzadas)
  hooks/
    useDashboardData.ts     init del adapter + SFDC, evidence por período en lotes rAF
    usePortfolio.ts         filtros + sort + KPIs + paginación → modelo de la vista
  features/
    portfolio/              Vista principal
      components/           TopBar, KpiStrip, PortfolioTabs, PortfolioTable, PortfolioRow, DefinitionsMatrix
    account-detail/         Panel expandido por cuenta
      EvidenceCard.tsx      Shell compartido por las 6 tarjetas
      cards/                Potential · Opportunities · BUY · LIST · SELL · Freshness
                            + CatalogReachTable, compartida por LIST y BUY
sql/                        Mapa JSON → query, con el estado de cada fuente
  README.md                 Estado por fuente, reglas del modelo, hallazgos
  cubes/ evidence/ salesforce/ manual/
tests/
  adapter.parity.test.ts    Compara el adapter TS contra el evidence_adapter_v3.js original
  adapter.periods.test.ts   Cruza fees / sell / buy de cada período contra sumas crudas de los JSON
  legacy/                   Copia del adapter JS original, solo para el test de paridad
```

**Regla de dependencias:** `components/ui` no importa de `domain` ni de `data`; `domain` no importa
de React; `features` compone todo. Los estilos son CSS Modules por componente sobre los tokens
globales de `styles/tokens.css`.

## De dónde salen los datos

La app es 100 % estática: lee los JSON de `public/data/` en el navegador. No hay backend ni consultas
en vivo. El adapter carga 18 archivos en paralelo, construye índices por `company_id` y calcula para
cada cuenta el objeto `AccountEvidence` (`identity`, `potential`, `buy`, `list`, `sell`, `benchmarks`,
`freshness`). Las reglas de negocio viven **solo** en `builders.ts`.

Todos los archivos van indexados por `company_id`, nunca por nombre. Indexar por nombre fue lo que
dejó 4.014 cuentas sin fila de config en una reconstrucción anterior.

### Qué sigue el selector de período y qué no

| | Archivos | Por qué |
|---|---|---|
| **Sigue el período** | los 4 cubos mensuales | tienen grano mensual real |
| **Prorrateado** | Est GMV, Est Buy | la cascada emite una cifra anual sin serie mensual: se reparte plano (anual × meses/12) |
| **Ventana fija** | `catalog_reach_v1` (12 meses cerrados) | la amplitud de catálogo depende del largo de la ventana; seguir el selector inventaría una caída de catálogo |
| **Foto con fecha** | inventory, buyers, vendors, config, benchmarks, temporal | son snapshots; cada uno se etiqueta con su `generated_at` en la tarjeta |

## Refrescar los datos

`sql/README.md` tiene el estado y la consulta de cada fuente. Los scripts de `scripts/` convierten
el resultado en el JSON con la forma que espera el adapter, y **todos escriben
`_metadata.generated_at`** — la falta de fecha en `accounts_v3` fue lo que dejó pasar meses de
desfase sin que nadie lo notara.

| Script | Reconstruye | Fuente |
|---|---|---|
| `rebuild_accounts_gmv.py` | la cascada de Est GMV de `accounts_v3` | cubo de sell |
| `rebuild_derived.py` | `gmv_pacing`, `benchmarks_v2` | otros JSON del repo, sin Snowflake |
| `rebuild_config_evidence.py` | `config_evidence_v2` | COMPANIES + COMPANY_SETTINGS + SALES_SV |
| `rebuild_hardgoods.py` | `hardgoods_v2` | SALES_SV (`product_category_division_name`) |
| `rebuild_catalog_reach.py` | `catalog_reach_v1` | SALES_SV + PROCUREMENTS_SV |
| `rebuild_inventory.py` | `inventory_current_v1` | INVENTORY_DETAILS — **corrida manual** |

Restricciones del MCP de Cortex, que condicionan todo lo anterior: solo ejecuta SQL generado por
Cortex Analyst, solo contra vistas semánticas (sufijo `_SV`) y siempre con `ks_flag = TRUE`.
`INVENTORY_DETAILS` no tiene vista semántica, así que `inventory_current` es la única fuente que se
refresca a mano (`sql/evidence/inventory_current.sql`). Y toda consulta hay que verificarla contra
`resultSetMetaData.numRows`: Snowflake trunca en silencio.

## Períodos y fórmulas

Cada métrica se calcula estrictamente dentro de un rango de meses explícito. Los cuatro períodos se
anclan en el último mes cerrado del cubo de sell (`_meta.period_to`, hoy **2026-08**):

| Período | Rango | Baseline YoY | Anualización |
|---|---|---|---|
| YTD 2026 | ene–ago 2026 | ene–ago 2025 | 12 / meses con datos |
| H1 2026 | ene–jun 2026 | ene–jun 2025 | 12 / 6 |
| Full 2025 | ene–dic 2025 | ene–dic 2024 | 1 (12 meses) |
| Last 12 months | sep 2025–ago 2026 | sep 2024–ago 2025 | 1 (12 meses) |

Los cuatro cubos se regeneraron a la misma ventana **ene-2024 → ago-2026**, así que todos los
períodos tienen baseline. El YoY solo se reporta cuando el cubo cubre el rango anterior completo: un
baseline parcial inventaría crecimiento.

**Take rate** = `(Direct Fees + Indirect Fees) / (Est Buy + Est Sell)`, los cuatro términos del mismo
período. Antes era `fees / koronet_sell`, que medía ejecución sobre el volumen que ya movemos y
estaba acotado por la propia tarifa.

**Est Buy** = 45 % del Est Sell (medido por Christine; la mediana del ORA da 0,50 sobre 19 cuentas,
así que el supuesto se sostiene), salvo cuando la compra medida supera esa estimación: ahí manda el
piso medido y la tarjeta lo declara como medición, no como modelo.

## Verificación

`tests/adapter.parity.test.ts` corre el adapter legacy (JS, en su versión **ya corregida**) y el
nuevo (TS) sobre los mismos JSON y exige salida idéntica para **todas** las cuentas (~4k), salvo
tres desviaciones que el test documenta. Esa paridad es la verificación más fuerte del port: las dos
implementaciones calculan lo mismo, campo por campo. **Cada cambio en `builders.ts` tiene que
espejarse en `tx-dashboards/evidence_adapter_v3.js` y copiarse a `tests/legacy/`.**

`tests/adapter.periods.test.ts` cruza fees / sell / buy de cada período contra sumas crudas de los
JSON, así que una regresión en el adapter no puede esconderse detrás del test de paridad.

## Diferencias deliberadas respecto al HTML original

Cada una salió de medir el original y encontrarlo mal, no de preferencia de diseño.

- **Fees ya no está inflado.** El legacy sumaba todas las filas de fees sin filtrar por mes y el cubo
  guardaba el YTD 2025 como una fila `total`: "Fees YTD" mostraba 2026 + 2025 ($2,51M contra $1,47M
  reales a nivel red). El cubo se regeneró con grano mensual real desde `TRANSACTION_FEES`.
- **Online = eCommerce + K2K + API (Regla 6).** El legacy solo reconocía la etiqueta `Online`, que el
  cubo usa desde ago-2025; los meses anteriores contaban como offline.
- **Est GMV se prorratea al período.** Antes la cifra anual se comparaba contra ocho meses de flujo
  medido, y la penetración salía sistemáticamente baja.
- **El "Medido" se verifica contra el cubo** con una tolerancia del 10 % antes de declarar la
  penetración tautológica. De 41 cuentas etiquetadas Medido/Piso, la mediana estaba en 0,83 de su
  etiqueta y Ninfa en 0,13; 23 quedaron marcadas como no verificadas.
- **La penetración de compra no hereda la tautología de la venta.** Eran 35 cuentas mostrando ~100 %
  con un Est Buy de modelo sin que nadie hubiera comparado nada: Pacifica Produce compra $0 contra un
  estimado de $23K, Mayesh el 85,9 %.
- **Donde la penetración es una identidad se dice, no se disfraza de logro.** El valor es el
  porcentaje real con el calificador `calculated measured`, en la tabla y en la tarjeta.
- **El gap de catálogo es una diferencia de conjuntos** (`total − online`), no `offline − online`.
  La resta de conteos daba negativo en 141 de 330 cuentas y subestimaba el gap de red 2,4x
  (70.062 publicado contra 167.031 real). Y las categorías se cuentan sobre el universo, no sobre el
  top-20: Mayesh tiene 581, no 20.
- **Seis motivos para el cero de venta**, en vez de leer todo como hueco de datos: no está live · la
  cascada dice que no vende · tier Procurement · sus ventas son auto-ventas · dejó de vender (con la
  fecha) · nunca vendió. El portafolio quedó en 100 % de cobertura explicada, cero huecos reales.
- **Las auto-ventas salen del sell GMV.** Son compras de la propia empresa espejadas en la tabla de
  ventas: $5,2M en 37 cuentas del portafolio.
- Los tabs **BUY / LIST / SELL / CONFIG / Declining** filtran la tabla (en el original solo mostraban
  el conteo), y el **sparkline** funciona: el original leía `m.sell_total`, un campo que no existe.
- **"Online vs what they sell" vive en la card 4 (LIST)**, no en SELL: pregunta por la visibilidad
  del catálogo. SELL responde por la demanda.
- La frescura de variedades compara contra la **mediana de la red** y el **techo del rango**, sobre
  las 147 cuentas con 100+ variedades online. Sin ese mínimo el "mejor" lo gana cualquiera con tres
  variedades y una venta reciente.
- El nav superior a otras páginas del Revenue OS se omitió: esos archivos no existen en el repo
  original.

## Deuda conocida

- **El 0.11 del Est GMV externo.** Las 128 cuentas con `gmv_source = "Estimado (AnnualRevenue×0.11)"`
  son literalmente `Annual_Total_Sales__c × 0.11` del ORA, y ese factor no está documentado por
  nadie. Deflacta el estimado ~9x y por lo tanto infla su penetración ~9x.
- **Los conteos únicos de red de inventory** están en `null` hasta que se corra la segunda consulta
  de `inventory_current.sql` (necesita dedup cruzada, no se pueden sumar por empresa).
- **`INVENTORY_DETAILS` no confirma visibilidad en el eShop.** Que `open_market` sea el pool que ve
  el comprador online es una hipótesis heredada del archivo original, no un hecho.
- **Fase 4:** los 20 JSON se cargan enteros en cada visita.

## Deploy

`.github/workflows/deploy-pages.yml` publica `dist/` en GitHub Pages en cada push a `main`.
`.github/workflows/ci.yml` corre typecheck, lint, tests y build en cada push y PR.
