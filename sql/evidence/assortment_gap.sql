-- ============================================================================
-- assortment_gap  →  genera public/data/assortment_gap_v1.json
-- Grano  : company × categoría canónica faltante
-- Fuente : SALE_DETAILS × PRODUCTS (por product_id)
-- Estado : ⛔ NO EJECUTABLE DESDE EL MCP DE CORTEX — necesita el join.
--          Lista para correr con acceso directo (el usuario de servicio de
--          docs/automatizacion.md) o a mano.
-- ----------------------------------------------------------------------------
-- QUÉ RESPONDE
--
--   "De las categorías que vende el núcleo del mercado, ¿cuáles no vende esta
--    cuenta?" — y cuánto mueven en ellas los que sí las venden.
--
-- No responde "perdió la venta porque no lo tenía". Eso requeriría seguir a un
-- comprador entre vendedores, y NO SE PUEDE: se verificó que los 69.203
-- clientes de la red tienen exactamente un vendedor cada uno. Cada wholesaler
-- tiene su propia lista de clientes, así que el mismo florista aparece como dos
-- customer_id distintos y nada los une. Esto es un hueco de surtido, no una
-- fuga medida, y la tarjeta tiene que decirlo con esas palabras.
--
-- ----------------------------------------------------------------------------
-- POR QUÉ SE AGRUPA POR category_network_code_id Y NO POR EL NOMBRE ← lo clave
--
-- `product_category_name` es TEXTO LIBRE por empresa. Medido sobre los 12 meses
-- cerrados: 3.997 nombres distintos, de los cuales 2.739 (69%) los usa una sola
-- empresa. Y el núcleo está lleno de variantes del mismo concepto:
--
--   Rose(184) + Roses(43) + ROSE(34) + ROSES(21)
--   Rose Spray(126) + Spray Rose(39) + Spray Roses(32) + SPRAY ROSE(26)
--   Hydrangea(194) + HYDRANGEA(40)
--
-- Solo en los 136 nombres que usan 20+ empresas, normalizar colapsa a 89: 35%
-- menos. Tres problemas superpuestos — mayúsculas, plurales y orden de palabras
-- (Rose Spray vs Spray Rose, Calla Mini vs Mini Calla).
--
-- Comparar surtido sobre el texto libre INVENTA HUECOS: si A escribe "ROSE" y B
-- escribe "Roses", la comparación concluye que a B le faltan rosas.
--
-- Y normalizar a mano tampoco alcanza: una regla genérica de plurales rompe los
-- nombres latinos (RANUNCULUS → RANUNCULU, DIANTHUS → DIANTHU), que en un
-- catálogo de flores es medio universo.
--
-- La salida es que Komet YA TIENE la taxonomía canónica: PRODUCTS trae
-- `category_network_code_id` / `category_network_code_name`. El código 1274 =
-- "Rosa" agrupa Rose Garden, Rose Spray, Rose, ROSES ECUADOR, Roses y las demás
-- variantes. Agrupando por el id, el problema desaparece y además queda robusto
-- ante nombres nuevos.
--
-- OJO: SALES_SV no expone el network code. Hay que ir por product_id contra
-- PRODUCTS, que es justo lo que hace esta consulta y lo que la deja fuera del
-- alcance del MCP.
--
-- ----------------------------------------------------------------------------
-- QUÉ SABEMOS DE ANTEMANO SOBRE SU UTILIDAD
--
-- El surtido NO explica el tamaño en el medio de la distribución. Correlación
-- log(GMV) vs nº de categorías: +0,41. Por cuartil de GMV:
--
--   Q1  $0,01M → 10 categorías     Q3  $1,34M → 48 categorías
--   Q2  $0,21M → 48 categorías     Q4  $6,78M → 65 categorías
--
-- Entre Q2 y Q3 el GMV se multiplica por 6 con el MISMO surtido. El salto real
-- está en Q1→Q2. O sea: para una cuenta que ya tiene ~48 categorías, este
-- reporte es una lista de candidatas, no un diagnóstico de crecimiento. Y la
-- flecha causal probablemente va al revés — venden más categorías porque son
-- grandes, no son grandes porque venden más categorías.
-- ============================================================================

-- Parámetros de la corrida -------------------------------------------------
--   MIN_EMPRESAS_NUCLEO  cuántas empresas tienen que vender una categoría para
--                        que contarla como "del mercado" y no como etiqueta
--                        propia. 37 = 10% de la red.
--   TOP_LIDERES          cuántos líderes por banda definen el referente.

WITH ventas AS (
    SELECT
        sd.company_id,
        p.category_network_code_id   AS cat_id,
        p.category_network_code_name AS cat_name,
        sd.sales,
        sd.sale_item_id
    FROM PRODUCTION.ANALYTICS.SALE_DETAILS sd
    JOIN PRODUCTION.ANALYTICS.PRODUCTS     p  ON p.product_id = sd.product_id
    JOIN PRODUCTION.ANALYTICS.COMPANIES    c  ON c.company_id = sd.company_id
    WHERE c.ks_flag = TRUE                       -- R1
      AND sd.sales < 100000                      -- R4, por línea, nunca en HAVING
      AND sd.shipping_date >= '2025-09-01'
      AND sd.shipping_date <  '2026-09-01'
      AND p.category_network_code_id IS NOT NULL -- sin código canónico no se compara
),

-- Tamaño de cada empresa y su banda, calculados acá para que la consulta sea
-- autónoma: accounts_v3 vive en el repo, no en Snowflake.
empresa AS (
    SELECT company_id,
           SUM(sales)                        AS gmv,
           COUNT(DISTINCT cat_id)            AS categorias,
           NTILE(4) OVER (ORDER BY SUM(sales)) AS banda
    FROM ventas
    GROUP BY company_id
),

surtido AS (
    SELECT DISTINCT company_id, cat_id FROM ventas
),

-- El núcleo del mercado: categorías que vende una porción relevante de la red.
-- Una categoría que vende una sola empresa no es un hueco de surtido.
nucleo AS (
    SELECT cat_id,
           MAX(cat_name)              AS cat_name,
           COUNT(DISTINCT company_id) AS empresas
    FROM ventas
    GROUP BY cat_id
    HAVING COUNT(DISTINCT company_id) >= 37      -- MIN_EMPRESAS_NUCLEO
),

-- Los líderes de cada banda: el mejor que se le parece, no el más grande de la
-- red. Comparar un wholesaler de $2M contra Mayesh da una lista de 300 ítems
-- que no le sirve a nadie.
lideres AS (
    SELECT company_id, banda
    FROM (SELECT company_id, banda,
                 ROW_NUMBER() OVER (PARTITION BY banda ORDER BY gmv DESC) AS puesto
          FROM empresa)
    WHERE puesto <= 5                            -- TOP_LIDERES
),

-- Qué vende el líder de cada banda, y cuánto mueve ahí.
surtido_lideres AS (
    SELECT l.banda, v.cat_id,
           COUNT(DISTINCT v.company_id) AS lideres_que_la_venden,
           SUM(v.sales)                 AS gmv_lideres
    FROM ventas v
    JOIN lideres l ON l.company_id = v.company_id
    GROUP BY l.banda, v.cat_id
)

SELECT
    e.company_id,
    e.banda,
    e.gmv                       AS gmv_12m,
    e.categorias                AS categorias_que_vende,
    n.cat_id,
    n.cat_name,
    n.empresas                  AS empresas_de_la_red_que_la_venden,
    ROUND(100.0 * n.empresas / (SELECT COUNT(*) FROM empresa), 1) AS pct_red,
    COALESCE(sl.lideres_que_la_venden, 0) AS lideres_de_su_banda_que_la_venden,
    COALESCE(sl.gmv_lideres, 0)           AS gmv_de_los_lideres_en_esa_categoria
FROM empresa e
CROSS JOIN nucleo n
LEFT JOIN surtido  s  ON s.company_id = e.company_id AND s.cat_id = n.cat_id
LEFT JOIN surtido_lideres sl ON sl.banda = e.banda   AND sl.cat_id = n.cat_id
WHERE s.cat_id IS NULL          -- el hueco: está en el núcleo y ella no la vende
ORDER BY e.company_id, sl.gmv_lideres DESC NULLS LAST;

-- ============================================================================
-- VOLUMEN ESPERADO
--
-- 367 empresas × (77 categorías del núcleo − las que ya vende). En la práctica
-- unas pocas miles de filas: chico como archivo, imposible de pasar por una
-- conversación. Va por el pipeline, como inventory.
--
-- CÓMO ARMAR EL JSON
--
--   python3 scripts/rebuild_assortment_gap.py --csv <resultado>
--
-- El script debería quedarse con el top N por empresa ordenado por
-- gmv_de_los_lideres_en_esa_categoria, y guardar pct_red junto a cada fila: sin
-- eso, la tarjeta no puede distinguir "no vendés algo que vende medio mercado"
-- de "no vendés algo que venden 37 empresas de 367".
-- ============================================================================
