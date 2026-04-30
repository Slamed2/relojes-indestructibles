// GET /thumb/<slug>/<filename>?w=400&fmt=webp
// Devuelve una versión redimensionada de la imagen original (que vive en
// product_media). Cachea el thumb en data/thumbs/ para no procesar de nuevo.

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { getSql } from '../services/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMBS_DIR = path.join(__dirname, '../../data/thumbs');

const router = express.Router();

const VALID_FMT = new Set(['webp', 'jpeg']);
const SAFE_PART = /^[\w.-]+$/;

function badPart(s) {
  return !s || !SAFE_PART.test(s) || s.startsWith('.') || s.includes('..');
}

async function loadOriginal(slug, filename) {
  try {
    const sql = getSql();
    const [row] = await sql`
      SELECT data, uploaded_at FROM product_media
      WHERE product_slug = ${slug} AND filename = ${filename}
    `;
    if (row) return { buffer: row.data, mtimeMs: new Date(row.uploaded_at).getTime() };
  } catch (err) {
    console.warn('[thumb] DB:', err.message);
  }
  return null;
}

router.get('/:slug/:filename', async (req, res) => {
  try {
    const { slug, filename } = req.params;
    if (badPart(slug) || badPart(filename)) return res.status(400).end();

    let w = parseInt(req.query.w, 10);
    if (!Number.isFinite(w)) w = 400;
    w = Math.max(80, Math.min(1600, w));

    let fmt = String(req.query.fmt || 'webp').toLowerCase();
    if (!VALID_FMT.has(fmt)) fmt = 'webp';

    const original = await loadOriginal(slug, filename);
    if (!original) return res.status(404).end();

    const cacheKey = `${slug}__${filename}`.replace(/\.[^.]+$/, '');
    const cacheName = `${cacheKey}_${w}.${fmt}`;
    const cachePath = path.join(THUMBS_DIR, cacheName);

    try {
      const cacheStat = await fs.stat(cachePath);
      if (cacheStat.mtimeMs >= original.mtimeMs) {
        res.setHeader('Content-Type', fmt === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return fsSync.createReadStream(cachePath).pipe(res);
      }
    } catch { /* cache miss */ }

    await fs.mkdir(THUMBS_DIR, { recursive: true });
    const pipeline = sharp(original.buffer).resize({ width: w, withoutEnlargement: true });
    const buf = await (fmt === 'webp'
      ? pipeline.webp({ quality: 78 })
      : pipeline.jpeg({ quality: 80, mozjpeg: true })
    ).toBuffer();
    await fs.writeFile(cachePath, buf);

    res.setHeader('Content-Type', fmt === 'webp' ? 'image/webp' : 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(buf);
  } catch (err) {
    console.error('thumb error:', err.message);
    res.status(500).end();
  }
});

export default router;
