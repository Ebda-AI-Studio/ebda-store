-- READ ONLY. Old-skin stores = stores still on a retired Force template with no Ebda look.
-- A store on an Ebda look is never old-skin, even when its template column says 'minimal'
-- (applyLook writes template = look.skin; a store could once sit on 'minimal' with a jasmine look).
-- Ruling SKIN-DEL-8: the Postgres enum keeps the five values, so old rows stay legal and are mapped
-- at READ time (packages/shared/src/templates/legacy-skin-map.ts); this gate reports them, it never
-- fixes them. The 'ebda-look' WHEN comes first on purpose: it wins over the template column.
WITH classified AS (
  SELECT
    id,
    slug,
    template::text AS template,
    look,
    CASE
      WHEN look IS NOT NULL AND look ~ '^(qamar|souq|jasmine|lamma|dahab)\.' THEN 'ebda-look'
      WHEN template::text IN ('modern','classic','minimal','bold','elegant')   THEN 'OLD-SKIN'
      WHEN template::text IN ('dahab','qamar','souq','jasmine','lamma')        THEN 'ebda-template'
      ELSE 'UNKNOWN'
    END AS class
  FROM stores
)
SELECT class, template, COALESCE(look, '(none)') AS look, count(*) AS stores
FROM classified
GROUP BY class, template, look
ORDER BY class DESC, template, look;

-- The gate: old-skin stores except the excluded list (Ruling SKIN-DEL-4: slug 'qa-walk-store-1010' is never touched).
SELECT count(*) AS old_skin_stores
FROM stores
WHERE slug <> 'qa-walk-store-1010'
  AND template::text IN ('modern','classic','minimal','bold','elegant')
  AND (look IS NULL OR look !~ '^(qamar|souq|jasmine|lamma|dahab)\.');

-- The excluded list, for Ahmad (read at render time only, never migrated):
SELECT id, slug, template::text AS template, look FROM stores
WHERE slug = 'qa-walk-store-1010'
   OR NOT (template::text IN ('modern','classic','minimal','bold','elegant','dahab','qamar','souq','jasmine','lamma')
           OR look ~ '^(qamar|souq|jasmine|lamma|dahab)\.');

-- Persisted places that may carry a retired skin name (they must still parse; the reader maps them).
SELECT 'store_page_revisions' AS surface, count(*) AS rows_naming_old_skin
FROM store_page_revisions
WHERE document::text ~ '"template"\s*:\s*"(modern|classic|minimal|bold|elegant)"'
UNION ALL
SELECT 'stores.theme', count(*) FROM stores WHERE theme::text ~ '"template"\s*:\s*"(modern|classic|minimal|bold|elegant)"'
UNION ALL
SELECT 'stores.layout_settings', count(*) FROM stores WHERE layout_settings::text ~ '"template"\s*:\s*"(modern|classic|minimal|bold|elegant)"';

-- The type has exactly one dependent column (informational: the enum is NOT contracted, SKIN-DEL-8).
SELECT c.relname AS table_name, a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname = 'StoreTemplate' AND a.attnum > 0 AND NOT a.attisdropped;
