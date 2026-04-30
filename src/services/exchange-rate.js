// Tasa de cambio USD → VES, fuente: dolarapi.com (paralelo).
// Refresh automático cada 4h. La tasa más reciente la lee `getLatestRate()`.
//
// Usado por:
//   - GET /api/exchange-rate (endpoint público)
//   - routes/products PUT/POST: si guardás price_usd sin price_ves, se
//     calcula automáticamente price_ves = price_usd * rate.

import { getSql } from './db.js';

const DEFAULT_SOURCE = 'paralelo';
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

let refreshTimer = null;

// Hace fetch a dolarapi y guarda el resultado en `exchange_rates`.
// Retorna {rate, fetched_at, source}.
export async function fetchAndStoreUsdRate(source = DEFAULT_SOURCE) {
  const url = `https://ve.dolarapi.com/v1/dolares/${source}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`dolarapi ${r.status}`);
  const data = await r.json();

  // Preferimos `promedio`. Si está null, fallback a venta o compra.
  const rate = Number(data.promedio ?? data.venta ?? data.compra);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`tasa inválida en respuesta: ${JSON.stringify(data)}`);
  }

  const sql = getSql();
  const [row] = await sql`
    INSERT INTO exchange_rates (source, currency, rate, fetched_at)
    VALUES (${source}, ${'USD'}, ${rate}, now())
    RETURNING source, currency, rate, fetched_at
  `;
  return {
    source: row.source,
    currency: row.currency,
    rate: Number(row.rate),
    fetched_at: row.fetched_at?.toISOString?.() || row.fetched_at,
  };
}

// Devuelve la tasa más reciente cacheada en la DB. null si nunca se hizo fetch.
export async function getLatestRate(source = DEFAULT_SOURCE) {
  try {
    const sql = getSql();
    const [row] = await sql`
      SELECT source, currency, rate, fetched_at
      FROM exchange_rates
      WHERE source = ${source} AND currency = ${'USD'}
      ORDER BY fetched_at DESC
      LIMIT 1
    `;
    if (!row) return null;
    return {
      source: row.source,
      currency: row.currency,
      rate: Number(row.rate),
      fetched_at: row.fetched_at?.toISOString?.() || row.fetched_at,
    };
  } catch {
    return null;
  }
}

// Arranca el loop de refresh. El primer fetch se hace inmediato; después
// cada REFRESH_INTERVAL_MS. No bloquea el boot.
export function startRefreshLoop() {
  if (refreshTimer) return;

  const refresh = async () => {
    try {
      const r = await fetchAndStoreUsdRate();
      console.log(`[exchange-rate] ${r.source}: Bs. ${r.rate} / USD (${r.fetched_at})`);
    } catch (err) {
      console.warn(`[exchange-rate] fetch falló:`, err.message);
    }
  };

  // Primer fetch en background (no esperamos).
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

export function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
