-- Precios duales (USD + VES) y soporte para audio/video.
--
-- Productos: la columna `price` (genérica) se renombra a `price_usd` y se
-- agrega `price_ves`. Si había datos en `price`, quedan en USD.
-- Si esa migración ya corrió antes (idempotencia), los ALTER se saltean.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'price'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'price_usd'
  ) THEN
    ALTER TABLE products RENAME COLUMN price TO price_usd;
  END IF;
END$$;

ALTER TABLE products ADD COLUMN IF NOT EXISTS price_usd NUMERIC(14, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_ves NUMERIC(14, 2);

-- product_media ya soporta cualquier content_type y data BYTEA. No requiere cambios
-- de schema para audio/video — solo el código de upload tiene que aceptar más MIME types.
