// Recorre las descripciones de productos, encuentra URLs a media (imágenes,
// videos, audio), las descarga, y las inserta en product_media.
//
// Idempotente: si una URL ya fue importada para ese slug (por source_url),
// la salta. Para forzar re-descarga, borrá la fila o pasá --force.
//
// Uso:
//   node --env-file=.env scripts/import-images-from-urls.mjs           # todos
//   node --env-file=.env scripts/import-images-from-urls.mjs <slug>    # uno
//   node --env-file=.env scripts/import-images-from-urls.mjs --dry     # preview
//
// Después de importar, conviene re-sincronizar el VS:
//   curl -X POST http://localhost:3000/api/products/sync-all

import { getSql, closeSql, runMigrations } from '../src/services/db.js';
import { syncProductFile } from '../src/services/products.js';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const FORCE = ARGS.includes('--force');
const ONLY_SLUG = ARGS.find((a) => !a.startsWith('--'));

// Mapeo extensión → (content_type, prefix). Si la extensión no está acá, skip.
const EXT_MAP = {
  jpg:  { ct: 'image/jpeg',      kind: 'imagen' },
  jpeg: { ct: 'image/jpeg',      kind: 'imagen' },
  png:  { ct: 'image/png',       kind: 'imagen' },
  webp: { ct: 'image/webp',      kind: 'imagen' },
  gif:  { ct: 'image/gif',       kind: 'imagen' },
  mp4:  { ct: 'video/mp4',       kind: 'video'  },
  webm: { ct: 'video/webm',      kind: 'video'  },
  mov:  { ct: 'video/quicktime', kind: 'video'  },
  mp3:  { ct: 'audio/mpeg',      kind: 'audio'  },
  ogg:  { ct: 'audio/ogg',       kind: 'audio'  },
  wav:  { ct: 'audio/wav',       kind: 'audio'  },
  m4a:  { ct: 'audio/mp4',       kind: 'audio'  },
};

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;

function parseExt(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,4})$/);
    if (!m) return null;
    return EXT_MAP[m[1]] ? { ext: m[1], ...EXT_MAP[m[1]] } : null;
  } catch {
    return null;
  }
}

// Para una descripción, devuelve URLs de media únicas, en orden de aparición.
function extractMediaUrls(desc) {
  const seen = new Set();
  const out = [];
  for (const u of (desc || '').match(URL_RE) || []) {
    if (seen.has(u)) continue;
    if (!parseExt(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function nextIndex(sql, slug, prefix) {
  const rows = await sql`SELECT filename FROM product_media WHERE product_slug = ${slug}`;
  const re = new RegExp(`^${prefix}(\\d+)\\.`, 'i');
  let n = 0;
  for (const r of rows) {
    const m = r.filename.match(re);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return n + 1;
}

async function downloadBuffer(url) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // Algunos hosts devuelven content-type genérico — preferimos lo de la URL.
  return { buf, contentType: r.headers.get('content-type') || null };
}

async function processSlug(sql, slug) {
  const [p] = await sql`SELECT slug, description FROM products WHERE slug = ${slug}`;
  if (!p) {
    console.log(`  ${slug}: no existe`);
    return { ok: 0, skip: 0, fail: 0 };
  }
  const urls = extractMediaUrls(p.description);
  console.log(`\n[${slug}] ${urls.length} URLs candidatas`);

  let ok = 0, skip = 0, fail = 0;
  for (const url of urls) {
    const meta = parseExt(url);
    if (!meta) { skip++; continue; }

    if (!FORCE) {
      const [hit] = await sql`
        SELECT id FROM product_media
        WHERE product_slug = ${slug} AND source_url = ${url}
        LIMIT 1
      `;
      if (hit) {
        skip++;
        console.log(`  · skip (ya importada): ${url.slice(0, 80)}`);
        continue;
      }
    }

    if (DRY) {
      console.log(`  · [dry] ${meta.kind}.${meta.ext}  ←  ${url.slice(0, 100)}`);
      ok++;
      continue;
    }

    try {
      const { buf, contentType } = await downloadBuffer(url);
      const n = await nextIndex(sql, slug, meta.kind);
      const filename = `${meta.kind}${n}.${meta.ext}`;
      await sql`
        INSERT INTO product_media (product_slug, variant_id, filename, content_type, data, display_order, uploaded_at, source_url)
        VALUES (${slug}, ${null}, ${filename}, ${contentType || meta.ct}, ${buf}, ${n}, now(), ${url})
      `;
      ok++;
      console.log(`  ✓ ${filename} (${(buf.length / 1024).toFixed(1)} KB)  ←  ${url.slice(0, 80)}`);
    } catch (err) {
      fail++;
      console.log(`  ✗ FALLA: ${url.slice(0, 100)}  →  ${err.message}`);
    }
  }
  console.log(`  resultado: ok=${ok}  skip=${skip}  fail=${fail}`);
  return { ok, skip, fail };
}

async function main() {
  // Aseguramos que la migración 007 (source_url) esté aplicada antes de
  // queries (incluso en dry-run, porque hacemos SELECT con source_url para
  // detectar dedup).
  try { await runMigrations(); } catch (err) {
    console.error('migraciones fallaron:', err.message);
    process.exit(1);
  }

  const sql = getSql();
  const products = ONLY_SLUG
    ? await sql`SELECT slug FROM products WHERE slug = ${ONLY_SLUG}`
    : await sql`SELECT slug FROM products ORDER BY slug`;

  console.log(`Procesando ${products.length} productos${DRY ? ' (DRY RUN)' : ''}${FORCE ? ' (FORCE)' : ''}`);

  let totals = { ok: 0, skip: 0, fail: 0 };
  const touchedSlugs = [];
  for (const p of products) {
    const r = await processSlug(sql, p.slug);
    totals.ok += r.ok;
    totals.skip += r.skip;
    totals.fail += r.fail;
    if (!DRY && r.ok > 0) touchedSlugs.push(p.slug);
  }

  console.log(`\n=========================`);
  console.log(`Total:  ok=${totals.ok}  skip=${totals.skip}  fail=${totals.fail}`);

  if (!DRY && touchedSlugs.length) {
    console.log(`\nRe-sincronizando ${touchedSlugs.length} productos al VS...`);
    for (const slug of touchedSlugs) {
      try {
        await syncProductFile(slug);
        console.log(`  ✓ ${slug}`);
      } catch (err) {
        console.log(`  ✗ ${slug}: ${err.message}`);
      }
    }
  }

  await closeSql();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
