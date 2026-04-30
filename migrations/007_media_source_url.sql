-- Trackea de dónde vino cada media (URL original) para evitar re-descargar
-- el mismo asset. Usado por scripts/import-images-from-urls.mjs.

ALTER TABLE product_media ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS product_media_source_url_idx
  ON product_media (product_slug, source_url)
  WHERE source_url IS NOT NULL;
