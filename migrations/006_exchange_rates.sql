-- Tasas de cambio. Guardamos histórico (1 fila por fetch) para poder ver
-- evolución. La tasa "actual" es siempre la fila más reciente por (source, currency).

CREATE TABLE IF NOT EXISTS exchange_rates (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,                -- "paralelo", "bcv", etc.
  currency TEXT NOT NULL,              -- "USD"
  rate NUMERIC(14, 4) NOT NULL,        -- ej. 630.3300 Bs por USD
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (source, currency, fetched_at DESC);
