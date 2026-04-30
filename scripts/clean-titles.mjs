// Limpia títulos de productos importados desde el VS, removiendo prefijos
// como "2. Producto:", "Producto: ", "1. ", etc. que vienen del catálogo viejo.

import { getSql, closeSql } from '../src/services/db.js';
import { syncProductFile } from '../src/services/products.js';

function cleanTitle(t) {
  return String(t)
    .replace(/^\s*\d+\s*\.\s*/, '')          // "2. ..." o "12. ..."
    .replace(/^Producto\s*:\s*/i, '')         // "Producto: ..."
    .replace(/^Producto\s+/i, '')             // "Producto ..."
    .trim();
}

async function main() {
  const sql = getSql();
  const products = await sql`SELECT slug, title FROM products`;
  console.log(`Procesando ${products.length} productos...\n`);

  let touched = 0;
  for (const p of products) {
    const next = cleanTitle(p.title);
    if (next === p.title) continue;
    await sql`UPDATE products SET title = ${next}, updated_at = now() WHERE slug = ${p.slug}`;
    console.log(`  ${p.slug}`);
    console.log(`    antes: ${p.title}`);
    console.log(`    ahora: ${next}`);
    // Re-sync al VS con el título nuevo (no bloqueante).
    syncProductFile(p.slug).catch((err) => console.error(`     sync falló:`, err.message));
    touched++;
  }

  console.log(`\nResultado: ${touched} títulos limpiados.`);
  await closeSql();
}

main().catch((err) => { console.error(err); process.exit(1); });
