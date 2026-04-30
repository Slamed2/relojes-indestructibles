// Endpoints CRUD del catálogo de productos.
//
//   GET    /api/products                    → lista todos
//   GET    /api/products/:slug              → detalle (con variantes e imágenes)
//   POST   /api/products                    → crear { title, description?, price? }
//   PUT    /api/products/:slug              → actualizar
//   DELETE /api/products/:slug              → borrar
//
//   GET    /api/products/:slug/variants     → listar variantes
//   POST   /api/products/:slug/variants     → crear variante
//   PUT    /api/products/:slug/variants/:id → actualizar
//   DELETE /api/products/:slug/variants/:id → borrar
//
//   POST   /api/products/:slug/images       → subir imagen (multipart, opcional variant_id)
//   DELETE /api/products/:slug/images/:id   → borrar imagen
//
//   POST   /api/products/sync-all           → re-sincronizar todo al VS

import express from 'express';
import multer from 'multer';
import {
  readProduct,
  listProducts,
  upsertProduct,
  deleteProduct,
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  syncProductFile,
  syncIndexFile,
  makeSlug,
  RESERVED_SLUGS,
} from '../services/products.js';
import { getSql } from '../services/db.js';
import { getLatestRate, fetchAndStoreUsdRate } from '../services/exchange-rate.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // 100 MB para soportar videos cortos. Si necesitás más, subir el límite acá.
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Mapeo de extensiones a MIME types soportados (imágenes + audio + video).
const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
const ALLOWED_EXT_RE = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov|mp3|ogg|wav|m4a)$/i;

// === Tasa de cambio USD → VES ===
//
// GET  /api/products/exchange-rate         → última tasa cacheada
// POST /api/products/exchange-rate/refresh → forzar fetch ahora
//
// Nota: estas rutas se declaran ANTES de "/:slug" para que no las capture el
// param dinámico.
router.get('/exchange-rate', async (_req, res) => {
  try {
    const r = await getLatestRate();
    if (!r) return res.status(404).json({ error: 'sin tasa cacheada todavía' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/exchange-rate/refresh', async (_req, res) => {
  try {
    const r = await fetchAndStoreUsdRate();
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calcula price_ves a partir de price_usd usando la última tasa.
// Solo aplica si hay USD pero no VES (o VES nulo). Si no hay tasa, deja null.
async function autoFillVes({ price_usd, price_ves }) {
  if (price_usd == null || price_usd === '') return { price_usd, price_ves };
  if (price_ves != null && price_ves !== '') return { price_usd, price_ves };
  const r = await getLatestRate();
  if (!r) return { price_usd, price_ves: null };
  const usdNum = Number(price_usd);
  if (!Number.isFinite(usdNum)) return { price_usd, price_ves: null };
  return { price_usd, price_ves: Number((usdNum * r.rate).toFixed(2)) };
}

// === Listado ===
router.get('/', async (_req, res) => {
  try {
    const products = await listProducts();
    // Para cada producto, agregar la URL de la primera imagen como preview.
    const sql = getSql();
    const previews = await sql`
      SELECT DISTINCT ON (product_slug) product_slug, filename
      FROM product_media
      WHERE variant_id IS NULL
      ORDER BY product_slug, display_order, id
    `;
    const previewMap = new Map(previews.map((r) => [r.product_slug, r.filename]));
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

    const out = products.map((p) => ({
      slug: p.slug,
      title: p.title,
      price_usd: p.price_usd,
      price_ves: p.price_ves,
      updated_at: p.updated_at,
      image: previewMap.has(p.slug) ? `${base}/imagenes/${p.slug}/${previewMap.get(p.slug)}` : null,
    }));

    res.json({ products: out, total: out.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Detalle ===
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const product = await readProduct(slug);
    if (!product) return res.status(404).json({ error: 'No existe' });
    const variants = await listVariants(slug);
    const sql = getSql();
    const media = await sql`
      SELECT id, filename, content_type, variant_id, display_order, description, uploaded_at
      FROM product_media
      WHERE product_slug = ${slug}
      ORDER BY display_order, id
    `;
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const enrichedMedia = media.map((m) => ({
      id: m.id,
      filename: m.filename,
      content_type: m.content_type,
      variant_id: m.variant_id,
      display_order: m.display_order,
      description: m.description || '',
      uploaded_at: m.uploaded_at,
      url: `${base}/imagenes/${slug}/${m.filename}`,
    }));
    res.json({ ...product, variants, media: enrichedMedia });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Crear ===
router.post('/', async (req, res) => {
  try {
    const { title, description, price_usd, price_ves } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title requerido' });
    const slug = makeSlug(title);
    if (!slug) return res.status(400).json({ error: 'title inválido' });
    if (RESERVED_SLUGS.has(slug)) {
      return res.status(400).json({ error: `slug reservado: "${slug}"` });
    }
    const existing = await readProduct(slug);
    if (existing) return res.status(409).json({ error: 'ya existe' });

    const filled = await autoFillVes({ price_usd, price_ves });
    await upsertProduct(slug, {
      title,
      description: description || '',
      price_usd: filled.price_usd ?? null,
      price_ves: filled.price_ves ?? null,
    });

    // Auto-sync al VS (no bloquea respuesta si falla).
    Promise.allSettled([syncProductFile(slug), syncIndexFile()]).then((results) => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`auto-sync [${i}]:`, r.reason?.message);
      });
    });

    res.json({ slug, title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Actualizar ===
router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const product = await readProduct(slug);
    if (!product) return res.status(404).json({ error: 'No existe' });

    const { title, description, price_usd, price_ves } = req.body || {};
    const nextUsd = price_usd !== undefined ? price_usd : product.price_usd;
    let nextVes = price_ves !== undefined ? price_ves : product.price_ves;

    // Si hay USD pero VES está vacío (null/undefined/""), calculamos con la
    // tasa. autoFillVes() respeta un VES ya seteado, así que llamarlo siempre
    // es seguro.
    const filled = await autoFillVes({ price_usd: nextUsd, price_ves: nextVes });
    nextVes = filled.price_ves;

    await upsertProduct(slug, {
      title: title ?? product.title,
      description: description ?? product.description,
      price_usd: nextUsd,
      price_ves: nextVes,
    });

    const [productRes, indexRes] = await Promise.allSettled([
      syncProductFile(slug),
      syncIndexFile(),
    ]);
    if (productRes.status === 'rejected') console.error('sync product:', productRes.reason?.message);
    if (indexRes.status === 'rejected') console.error('sync index:', indexRes.reason?.message);

    res.json({
      ok: true,
      openai_file_id: productRes.status === 'fulfilled' ? productRes.value : null,
      synced: productRes.status === 'fulfilled' && indexRes.status === 'fulfilled',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Borrar ===
router.delete('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    await deleteProduct(slug);
    syncIndexFile().catch((err) => console.error('sync index:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Variantes ===
router.get('/:slug/variants', async (req, res) => {
  try {
    res.json({ variants: await listVariants(req.params.slug) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:slug/variants', async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, description, display_order } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const product = await readProduct(slug);
    if (!product) return res.status(404).json({ error: 'producto no existe' });

    const variant = await createVariant(slug, { name, description, display_order });
    syncProductFile(slug).catch((err) => console.error('sync product:', err.message));
    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:slug/variants/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, display_order } = req.body || {};
    const variant = await updateVariant(id, { name, description, display_order });
    if (!variant) return res.status(404).json({ error: 'variante no existe' });
    syncProductFile(req.params.slug).catch((err) => console.error('sync product:', err.message));
    res.json(variant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:slug/variants/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deleteVariant(id);
    syncProductFile(req.params.slug).catch((err) => console.error('sync product:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Media (imágenes, video, audio) ===
//
// Acepta: jpg, jpeg, png, webp, gif, mp4, webm, mov, mp3, ogg, wav, m4a.
// El path POST /:slug/images se mantiene por compat (el frontend manda con
// el nombre "image"), pero realmente acepta cualquier media.
router.post('/:slug/images', upload.single('image'), async (req, res) => {
  try {
    const { slug } = req.params;
    if (!req.file) return res.status(400).json({ error: 'archivo requerido' });
    const product = await readProduct(slug);
    if (!product) return res.status(404).json({ error: 'producto no existe' });

    const variantId = req.body.variant_id ? parseInt(req.body.variant_id, 10) : null;
    const description = (req.body.description || '').trim();

    // Validar y deducir extensión.
    const extMatch = req.file.originalname.match(ALLOWED_EXT_RE);
    if (!extMatch) {
      return res.status(400).json({
        error: 'tipo de archivo no soportado. Permitidos: ' + Object.keys(EXT_TO_MIME).join(', '),
      });
    }
    const ext = extMatch[0].toLowerCase();
    const contentType = req.file.mimetype || EXT_TO_MIME[ext] || 'application/octet-stream';

    // Decidir el prefijo del nombre según el tipo (imagenN, videoN, audioN).
    let prefix = 'imagen';
    if (contentType.startsWith('video/')) prefix = 'video';
    else if (contentType.startsWith('audio/')) prefix = 'audio';

    const sql = getSql();

    // Próximo índice por slug + prefijo (imagenes, videos y audios cuentan separados).
    const existing = await sql`SELECT filename FROM product_media WHERE product_slug = ${slug}`;
    const re = new RegExp(`^${prefix}(\\d+)\\.`, 'i');
    let n = 1;
    if (existing.length) {
      const used = existing
        .map((r) => (r.filename.match(re) || [])[1])
        .filter(Boolean)
        .map((s) => parseInt(s, 10));
      if (used.length) n = Math.max(...used) + 1;
    }
    const filename = `${prefix}${n}${ext}`;

    const [inserted] = await sql`
      INSERT INTO product_media (product_slug, variant_id, filename, content_type, data, display_order, description, uploaded_at)
      VALUES (${slug}, ${variantId}, ${filename}, ${contentType}, ${req.file.buffer}, ${n}, ${description}, now())
      RETURNING id
    `;

    syncProductFile(slug).catch((err) => console.error('sync product:', err.message));

    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    res.json({
      id: inserted.id,
      filename,
      content_type: contentType,
      kind: prefix, // imagen | video | audio
      description,
      url: `${base}/imagenes/${slug}/${filename}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editar metadata de un media (solo description por ahora). El binario no se toca.
router.patch('/:slug/images/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { description } = req.body || {};
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'description (string) requerido' });
    }
    const sql = getSql();
    const [row] = await sql`
      UPDATE product_media
      SET description = ${description.trim()}
      WHERE id = ${id} AND product_slug = ${req.params.slug}
      RETURNING id, description
    `;
    if (!row) return res.status(404).json({ error: 'media no existe' });
    syncProductFile(req.params.slug).catch((err) => console.error('sync product:', err.message));
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:slug/images/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const sql = getSql();
    await sql`DELETE FROM product_media WHERE id = ${id} AND product_slug = ${req.params.slug}`;
    syncProductFile(req.params.slug).catch((err) => console.error('sync product:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Re-sync masivo ===
router.post('/sync-all', async (_req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    const products = await listProducts();
    send({ type: 'start', total: products.length });
    let done = 0;
    for (const p of products) {
      try {
        await syncProductFile(p.slug);
      } catch (err) {
        send({ type: 'error', slug: p.slug, error: err.message });
      }
      done++;
      send({ type: 'progress', current: done, total: products.length, slug: p.slug });
    }
    await syncIndexFile();
    send({ type: 'done', total: products.length });
  } catch (err) {
    send({ type: 'error', error: err.message });
  } finally {
    res.end();
  }
});

export default router;
