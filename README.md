# TX Dashboard · Revenue OS (React + TypeScript + Vite)

Migración de `tx-dashboards/tx-dashboard-v3.html` (un HTML monolítico de ~4.500 líneas) a una
aplicación React + TypeScript construida con Vite. La migración es **secuencial**: esta primera
fase entrega la interfaz base del dashboard con una estructura de carpetas escalable, el adapter
de datos tipado y verificado contra el original, y la lógica de negocio separada de la UI.

## Estado de la migración

| Fase | Alcance | Estado |
|---|---|---|
| **1 · Base** | Estructura del proyecto, tokens de estilo, adapter en TS con test de paridad, topbar con filtros, KPI strip, tabs, tabla de portafolio con sort/paginación, fila expandible con Identity / Key figures / Source coverage | ✅ |
| **1b · Períodos** | Modelo `Period` (YTD · Full year · Last 12 months) con rangos explícitos y baseline YoY like-for-like; fees filtrados por período (corrige el KPI inflado del legacy); cubo de fees regenerado con grano mensual real desde Snowflake | ✅ Esta entrega |
| 2 · Tarjetas | Las 6 tarjetas de evidencia (Potential, Opportunities, BUY, LIST, SELL, Freshness) dentro de la fila expandida | Pendiente |
| 3 · Definitions & Matrix | Matriz Est GMV × Product Tier con drill-down, tablas de metodología | Pendiente |
| 4 · Datos | Script de build que compacta los 15 JSON (~9.6 MB) en un bundle por vista; derivar el período desde `_meta` en todos lados | Pendiente |

## Cómo correrlo

```bash
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + lint + tests + build (lo mismo que corre CI)
```

Otros scripts: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run preview`.

## Estructura de carpetas

```
public/
  data/                     JSON de evidencia (copiados tal cual de tx-dashboards/data)
    current/                cubos mensuales sell / buy / fees + _manifest.json
src/
  app/                      App shell (hoy una sola vista; aquí entra el router cuando haya más páginas)
  styles/
    tokens.css              Variables de diseño (colores, tipografía, radios, sombras, layout)
    global.css              Reset + utilidades mínimas
  components/ui/            Primitivas reutilizables sin lógica de negocio
    SelectPill, TabButton/TabsNav, Chip (RemovableChip/ToggleChip), Badge, Sparkline, Spinner
  data/
    adapter/                Evidence Adapter — la capa de datos
      files.ts              Registro de archivos JSON + fetch tolerante a fallos + IDs excluidos
      period.ts             Modelo Period: ytd / prev_year / l12m anclados al último mes cerrado del cubo de sell
      types.ts              Tipos raw (shape de los JSON) y de dominio (AccountEvidence)
      helpers.ts            Agregaciones puras de cubos, deltas, meses
      store.ts              Carga en paralelo + índices por company_id
      builders.ts           Reglas de negocio: Piso de red, penetración, take rate, etc.
      index.ts              API pública (init, getAccountEvidence, getAllAccountIds, …)
    sfdc/openOpportunities.ts   Oportunidades abiertas de Salesforce → "$ at Stake"
  domain/                   Lógica pura sobre AccountEvidence (sin React, sin DOM)
    format.ts               fmtMoney, fmtPct, evValue…
    metrics.ts              $ at stake, diagnosis, opportunity flags, sparkline, GMV bands
    thresholds.ts           Umbrales → tono/qualifier de cada celda (una sola fuente de verdad)
    filters.ts              Modelo de filtros + applyFilters + conteos de tabs
    sort.ts                 Sort por columna
    kpis.ts                 KPIs del portafolio
    period.ts               Helpers de UI sobre el modelo Period del adapter (labels, descripción de rangos)
  state/filtersReducer.ts   Reducer de filtros (incluye las interacciones cruzadas)
  hooks/
    useDashboardData.ts     init del adapter + SFDC, evidence por timeframe en lotes rAF
    usePortfolio.ts         filtros + sort + KPIs + paginación → modelo de la vista
  features/
    portfolio/              Vista principal
      PortfolioView.tsx     Composición de la página
      filterOptions.ts      Listas estáticas de los dropdowns y chips
      components/           TopBar, KpiStrip, PortfolioTabs, PortfolioTable, PortfolioRow
    account-detail/         Panel expandido por cuenta (fase 1: Identity, Key figures, Coverage)
sql/                        Mapa JSON → query (Snowflake / Salesforce / Supabase) para la fase de datos en vivo
  README.md                 Estado por fuente, reglas del modelo, hallazgos
  cubes/                    sell / buy / fees (listas)
  evidence/                 fuentes V2 (pendientes de pegar) + derivadas (pacing, benchmarks)
  salesforce/               SOQL de oportunidades y cuentas
  manual/                   Esquema Supabase para overrides, GMV externo e IDs excluidos
tests/
  adapter.parity.test.ts    Compara el adapter TS contra el evidence_adapter_v3.js original
  legacy/                   Copia del adapter JS original, solo para el test de paridad
```

**Regla de dependencias:** `components/ui` no importa de `domain` ni de `data`; `domain` no importa
de React; `features` compone todo. Los estilos son CSS Modules por componente sobre los tokens
globales de `styles/tokens.css`.

## De dónde salen los datos

La app es 100 % estática: lee los JSON de `public/data/` en el navegador. No hay backend ni consultas
en vivo a Snowflake / Salesforce. El adapter (`src/data/adapter`) carga 14 archivos en paralelo,
construye índices por `company_id` y calcula para cada cuenta el objeto `AccountEvidence`
(`identity`, `potential`, `buy`, `list`, `sell`, `benchmarks`, `freshness`). Las reglas de negocio
(Piso de red, penetración, buy estimado = 45 % del sell, take rate) viven solo en `builders.ts`.

Para refrescar datos: regenerar los JSON con las queries documentadas en
`tx-dashboards/data/current/refresh_queries.md` y copiarlos a `public/data/`. El `_meta.period_to`
del cubo de sell alimenta las etiquetas del selector de período.

## Períodos y fórmulas

Cada métrica se calcula estrictamente dentro de un rango de meses explícito. Los tres períodos se
anclan en el último mes cerrado del cubo de sell (`_meta.period_to`, hoy 2026-07):

| Período | Rango | Baseline YoY | Anualización |
|---|---|---|---|
| YTD 2026 | ene–jul 2026 | ene–jul 2025 | 12 / meses con datos |
| Full year 2025 | ene–dic 2025 | ene–dic 2024 | 1 (12 meses) |
| Last 12 months | ago 2025–jul 2026 | ago 2024–jul 2025 | 1 (12 meses) |

Sell, buy y fees pasan por el mismo filtro (`filterByRange`); penetración, online % y take rate se
calculan con los valores del rango. El YoY solo se reporta cuando el cubo cubre el rango anterior
completo (el cubo de sell empieza en 2024-08 y el de fees en 2025-01, así que "Full year 2025" no
tiene YoY de sell y "Last 12 months" no tiene YoY de fees): un baseline parcial inventaría crecimiento.

## Verificación

`tests/adapter.parity.test.ts` ejecuta el adapter original (JS) y el nuevo (TS) sobre los mismos JSON
y exige salida idéntica para **todas** las cuentas (~4k) en YTD, salvo tres desviaciones deliberadas
que el test documenta: fees filtrados por período, canales online según Regla 6, y "mes actual" =
último mes dentro del período. `tests/adapter.periods.test.ts` cruza fees / sell / buy de cada período
contra sumas crudas de los JSON. La UI se verificó además comparando KPIs, conteos de tabs y orden de
filas contra el HTML original: coinciden en todo menos en fees (ver abajo).

## Diferencias deliberadas respecto al HTML original

- **Fees ya no está inflado.** El legacy sumaba todas las filas de fees de la compañía sin filtrar por
  mes, y `fees_monthly.json` (24-ago) incluía el YTD 2025 como una fila `total`, así que "Fees YTD"
  mostraba 2026 + 2025 ($2.51M vs $1.47M reales a nivel red; $351K vs $220K para Client Wholesalers).
  El cubo se regeneró desde `PRODUCTION.ANALYTICS.TRANSACTION_FEES` (billed, `ks_flag=TRUE`, mes por
  `transaction_date`) con grano mensual real ene-2025 → ago-2026, lo que además habilita el YoY de fees.
- **Online = eCommerce + K2K + API (Regla 6).** El legacy solo reconocía la etiqueta `Online`, que el
  cubo usa desde ago-2025; los meses anteriores usan `eCommerce/K2K/API` y contaban como offline.
- El selector de período ofrece YTD · Full year · Last 12 months en vez de YTD / Jul / Jun / Q2 / H1
  (que en el legacy no cambiaban las cifras del portafolio: todo era YTD).
- Los tabs **BUY / LIST / SELL / CONFIG / Declining** ahora filtran la tabla (en el original solo
  mostraban el conteo).
- El **sparkline** de tendencia funciona: el original leía `m.sell_total`, un campo que no existe
  (es `sell_gmv`), por lo que siempre se pintaba plano.
- El nav superior a otras páginas del Revenue OS (`changes.html`, `issues.html`…) se omitió porque
  esos archivos no existen en el repo original.

## Deploy

`.github/workflows/deploy-pages.yml` publica `dist/` en GitHub Pages en cada push a `main`
(hay que habilitar Pages → Source: *GitHub Actions* en Settings). `.github/workflows/ci.yml` corre
typecheck, lint, tests y build en cada PR.
