// Capa de datos del catálogo de productos.
// Storage: Postgres (productos + variantes + media). Vector store: 1 archivo
// por producto + 1 archivo `lista-productos.md` con el índice.

import fs from 'fs/promises';
import path from 'path';
import slugify from 'slugify';
import { fileURLToPath } from 'url';
import { getSql } from './db.js';
import {
  syncFileToVectorStore,
  deleteFromVectorStore,
  dedupeByFilename,
} from './openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, '../../data/tmp');

export function makeSlug(input) {
  return slugify(input, { lower: true, strict: true, trim: true });
}

// Slugs reservados por el sistema — no se pueden usar como producto.
export const RESERVED_SLUGS = new Set(['_', 'lista-productos', 'admin']);

// === Settings ===

export async function readCatalogSettings() {
  const sql = getSql();
  const [row] = await sql`SELECT * FROM catalog_settings WHERE id = 1`;
  return {
    preamble: row?.preamble || '',
    index_file_id: row?.index_file_id || null,
    updated_at: row?.updated_at?.toISOString?.() || row?.updated_at || null,
  };
}

export async function writeCatalogSettings(patch) {
  const sql = getSql();
  await sql`
    UPDATE catalog_settings SET
      preamble = ${patch.preamble ?? ''},
      index_file_id = ${patch.index_file_id ?? null},
      updated_at = now()
    WHERE id = 1
  `;
}

// === Productos ===

export async function readProduct(slug) {
  const sql = getSql();
  const [row] = await sql`SELECT * FROM products WHERE slug = ${slug}`;
  if (!row) return null;
  return {
    slug: row.slug,
    title: row.title,
    description: row.description || '',
    price_usd: row.price_usd != null ? Number(row.price_usd) : null,
    price_ves: row.price_ves != null ? Number(row.price_ves) : null,
    openai_file_id: row.openai_file_id,
    display_order: row.display_order,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

export async function listProducts() {
  const sql = getSql();
  const rows = await sql`
    SELECT slug, title, description, price_usd, price_ves, openai_file_id, display_order, created_at, updated_at
    FROM products
    ORDER BY (display_order IS NULL), display_order ASC, slug ASC
  `;
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description || '',
    price_usd: r.price_usd != null ? Number(r.price_usd) : null,
    price_ves: r.price_ves != null ? Number(r.price_ves) : null,
    openai_file_id: r.openai_file_id,
    display_order: r.display_order,
    created_at: r.created_at?.toISOString?.() || r.created_at,
    updated_at: r.updated_at?.toISOString?.() || r.updated_at,
  }));
}

export async function upsertProduct(slug, data) {
  const sql = getSql();
  await sql`
    INSERT INTO products (slug, title, description, price_usd, price_ves, openai_file_id, created_at, updated_at)
    VALUES (
      ${slug},
      ${data.title || slug},
      ${data.description ?? ''},
      ${data.price_usd ?? null},
      ${data.price_ves ?? null},
      ${data.openai_file_id ?? null},
      ${data.created_at || new Date().toISOString()},
      now()
    )
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      price_usd = EXCLUDED.price_usd,
      price_ves = EXCLUDED.price_ves,
      openai_file_id = COALESCE(EXCLUDED.openai_file_id, products.openai_file_id),
      updated_at = now()
  `;
}

export async function deleteProduct(slug) {
  const sql = getSql();
  const product = await readProduct(slug);
  if (!product) return;
  if (product.openai_file_id) {
    await deleteFromVectorStore(product.openai_file_id).catch(() => {});
  }
  await sql`DELETE FROM products WHERE slug = ${slug}`;
}

// === Variantes ===

export async function listVariants(productSlug) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM product_variants
    WHERE product_slug = ${productSlug}
    ORDER BY display_order NULLS LAST, id ASC
  `;
  return rows;
}

export async function createVariant(productSlug, data) {
  const sql = getSql();
  const [row] = await sql`
    INSERT INTO product_variants (product_slug, name, description, display_order)
    VALUES (${productSlug}, ${data.name}, ${data.description ?? ''}, ${data.display_order ?? null})
    RETURNING *
  `;
  return row;
}

export async function updateVariant(id, data) {
  const sql = getSql();
  const [row] = await sql`
    UPDATE product_variants SET
      name = ${data.name},
      description = ${data.description ?? ''},
      display_order = ${data.display_order ?? null},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return row;
}

export async function deleteVariant(id) {
  const sql = getSql();
  await sql`DELETE FROM product_variants WHERE id = ${id}`;
}

// === Vector Store sync ===

const VS_EXCLUDE_RESERVED = new Set([...RESERVED_SLUGS]);

// Construye el .md que se sube al VS por producto. Incluye título, descripción,
// precio, variantes y URLs de imágenes (rewriteable a absolutas).
export async function buildProductMd(slug) {
  const product = await readProduct(slug);
  if (!product) throw new Error(`Producto ${slug} no existe`);
  const variants = await listVariants(slug);
  const sql = getSql();
  const media = await sql`
    SELECT id, filename, content_type, variant_id, description FROM product_media
    WHERE product_slug = ${slug}
    ORDER BY display_order, id
  `;

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const mediaUrl = (filename) => `${base}/imagenes/${slug}/${filename}`;

  // Devuelve el "kind" estable basado en content_type.
  const kindOf = (m) => {
    const ct = m.content_type || '';
    if (ct.startsWith('video/')) return 'video';
    if (ct.startsWith('audio/')) return 'audio';
    return 'imagen';
  };
  // Etiqueta canónica para el agente: IMAGEN_DE / VIDEO_DE / AUDIO_DE.
  const labelOf = (m) => kindOf(m).toUpperCase() + '_DE';

  // Lista plana → líneas con caption opcional. El caption va después de "—".
  const renderMediaList = (items, ownerName) => {
    const out = [];
    for (const m of items) {
      const cap = (m.description || '').trim().replace(/\s+/g, ' ');
      const tail = cap ? ` — ${cap}` : '';
      out.push(`- ${labelOf(m)} "${ownerName}" → ${mediaUrl(m.filename)}${tail}`);
    }
    return out;
  };

  const lines = [`### ${product.title}`, ''];

  if (product.description?.trim()) {
    lines.push(product.description.trim(), '');
  }

  // Precios duales (cualquiera puede ser null).
  const priceParts = [];
  if (product.price_usd != null) priceParts.push(`USD $${formatUsd(product.price_usd)}`);
  if (product.price_ves != null) priceParts.push(`Bs. ${formatVes(product.price_ves)}`);
  if (priceParts.length) {
    lines.push(`**Precio:** ${priceParts.join(' · ')}`, '');
  }

  // Media general del producto (sin variante).
  const generalMedia = media.filter((m) => !m.variant_id);
  const byKind = {
    imagen: generalMedia.filter((m) => kindOf(m) === 'imagen'),
    video:  generalMedia.filter((m) => kindOf(m) === 'video'),
    audio:  generalMedia.filter((m) => kindOf(m) === 'audio'),
  };
  if (byKind.imagen.length) {
    lines.push('**Imágenes:**', '', ...renderMediaList(byKind.imagen, product.title), '');
  }
  if (byKind.video.length) {
    lines.push('**Videos:**', '', ...renderMediaList(byKind.video, product.title), '');
  }
  if (byKind.audio.length) {
    lines.push('**Audios:**', '', ...renderMediaList(byKind.audio, product.title), '');
  }

  // Variantes.
  for (const v of variants) {
    lines.push(`**Variante: ${v.name}**`, '');
    if (v.description?.trim()) {
      lines.push(v.description.trim(), '');
    }
    const vMedia = media.filter((m) => m.variant_id === v.id);
    if (vMedia.length) {
      lines.push(...renderMediaList(vMedia, v.name), '');
    }
  }

  return lines.join('\n').trim() + '\n';
}

function formatUsd(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatVes(n) {
  return Number(n).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Sube/actualiza el archivo del producto en el VS.
export async function syncProductFile(slug) {
  if (VS_EXCLUDE_RESERVED.has(slug)) return null;
  const product = await readProduct(slug);
  if (!product) throw new Error(`Producto ${slug} no existe`);

  const md = await buildProductMd(slug);

  await fs.mkdir(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, `${slug}.md`);
  await fs.writeFile(tmpPath, md);

  const sql = getSql();
  const newFileId = await syncFileToVectorStore({
    filePath: tmpPath,
    filename: `${slug}.md`,
    previousFileId: product.openai_file_id || null,
  });

  await sql`UPDATE products SET openai_file_id = ${newFileId}, updated_at = now() WHERE slug = ${slug}`;
  await fs.unlink(tmpPath).catch(() => {});
  return newFileId;
}

// Construye el índice slim del catálogo (solo títulos + precio).
export async function buildIndexMd() {
  const products = await listProducts();
  const lines = [
    '# Catálogo de productos',
    '',
    `Listado actualizado de productos disponibles. Para detalles de un producto en particular (descripción, variantes, imágenes), buscá su archivo individual en el vector store por slug.`,
    '',
    '## Productos disponibles',
    '',
  ];
  for (const p of products) {
    const parts = [];
    if (p.price_usd != null) parts.push(`USD $${formatUsd(p.price_usd)}`);
    if (p.price_ves != null) parts.push(`Bs. ${formatVes(p.price_ves)}`);
    const priceTxt = parts.length ? ` — ${parts.join(' · ')}` : '';
    lines.push(`- ${p.title}${priceTxt}`);
  }
  lines.push('', `**Total:** ${products.length} producto${products.length === 1 ? '' : 's'}.`, '');
  return lines.join('\n');
}

// Sube el índice del catálogo al VS y persiste el file_id.
export async function syncIndexFile() {
  const md = await buildIndexMd();
  await fs.mkdir(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, 'lista-productos.md');
  await fs.writeFile(tmpPath, md);

  const settings = await readCatalogSettings();
  const newFileId = await syncFileToVectorStore({
    filePath: tmpPath,
    filename: 'lista-productos.md',
    previousFileId: settings.index_file_id || null,
  });

  // Defensivo: limpiar duplicados con el mismo nombre.
  try { await dedupeByFilename('lista-productos.md', newFileId); }
  catch (err) { console.warn('dedupeByFilename:', err.message); }

  await writeCatalogSettings({ ...settings, index_file_id: newFileId });
  await fs.unlink(tmpPath).catch(() => {});
  return newFileId;
}
