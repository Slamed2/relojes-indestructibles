// Importa productos desde el Vector Store a la tabla `products`.
// Solo procesa archivos con prefijo `productos__`. El resto de los archivos
// del VS (bot, chatrace, difusiones, seguimientos) NO se tocan.
//
// Uso:
//   node --env-file=.env scripts/import-products-from-vs.mjs
//   node --env-file=.env scripts/import-products-from-vs.mjs --dry  (preview)

import { listVectorStoreFiles, downloadFileContent } from '../src/services/openai.js';
import { getSql, runMigrations, closeSql } from '../src/services/db.js';
import { upsertProduct } from '../src/services/products.js';

const DRY = process.argv.includes('--dry');

// Extrae título del primer `### Título` o `# Título` del markdown.
// Si no encuentra, usa el slug humanizado.
function extractTitle(md, slugFallback) {
  const m = md.match(/^#{1,3}\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  return slugFallback
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Extrae el cuerpo del markdown sin el primer header.
function extractBody(md) {
  return md.replace(/^#{1,3}\s+.+?\s*$/m, '').trim();
}

async function main() {
  console.log('=== Importando productos del VS → tabla `products` ===\n');

  console.log('[1/3] Aplicando migraciones SQL...');
  await runMigrations();

  const sql = getSql();

  console.log('\n[2/3] Listando archivos del VS...');
  const files = await listVectorStoreFiles();
  const productFiles = files.filter((f) => f.filename.startsWith('productos__'));
  console.log(`  ${productFiles.length} archivos productos__* encontrados`);

  console.log('\n[3/3] Descargando e importando...');
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const f of productFiles) {
    // slug = filename sin "productos__" y sin ".md"
    const slug = f.filename
      .replace(/^productos__/, '')
      .replace(/\.md$/i, '');

    try {
      const content = await downloadFileContent(f.id);
      if (!content) {
        console.log(`  ⚠ ${slug}: contenido vacío, salto`);
        skipped++;
        continue;
      }

      const title = extractTitle(content, slug);
      const description = extractBody(content);

      if (DRY) {
        console.log(`  [dry] ${slug} → "${title}" (${description.length} chars)`);
        imported++;
        continue;
      }

      await upsertProduct(slug, {
        title,
        description,
        price: null, // se carga manualmente desde la UI
        openai_file_id: f.id,
      });
      imported++;
      if (imported % 5 === 0) console.log(`  ${imported}/${productFiles.length}...`);
    } catch (err) {
      console.error(`  ✗ ${slug}: ${err.message}`);
      errors++;
    }
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM products`;

  console.log('\n=== Resultado ===');
  console.log(`Importados:           ${imported}`);
  console.log(`Salteados:            ${skipped}`);
  console.log(`Errores:              ${errors}`);
  console.log(`Total filas products: ${count}`);
  if (DRY) console.log('\n[dry-run] Para aplicar de verdad: corré sin --dry');

  await closeSql();
}

main().catch((err) => { console.error(err); process.exit(1); });
