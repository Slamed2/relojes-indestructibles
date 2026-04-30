-- Schema inicial: catálogo de productos + variantes + media.
-- Idempotente — se puede correr múltiples veces sin perder datos.

CREATE TABLE IF NOT EXISTS products (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(12, 2),                  -- precio único; null si "consultar"
  openai_file_id TEXT,                   -- id del archivo en el VS
  display_order INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_display_order_idx ON products (display_order, slug);
CREATE INDEX IF NOT EXISTS products_updated_at_idx ON products (updated_at DESC);

-- Variantes del producto (modelos). Pueden ser 0 o N por producto.
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_slug TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- "Modelo Negro Mate"
  description TEXT NOT NULL DEFAULT '',  -- detalles específicos de la variante
  display_order INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_variants_product_idx ON product_variants (product_slug, display_order);

-- Imágenes del producto. variant_id NULL = imagen general del producto;
-- variant_id no-null = imagen específica de esa variante.
CREATE TABLE IF NOT EXISTS product_media (
  id SERIAL PRIMARY KEY,
  product_slug TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_slug, filename)
);

CREATE INDEX IF NOT EXISTS product_media_product_idx ON product_media (product_slug, display_order);
CREATE INDEX IF NOT EXISTS product_media_variant_idx ON product_media (variant_id);

-- Settings global del catálogo.
CREATE TABLE IF NOT EXISTS catalog_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  preamble TEXT NOT NULL DEFAULT '',
  index_file_id TEXT,                    -- file_id en el VS del archivo "lista-productos.md"
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO catalog_settings (id, preamble) VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
