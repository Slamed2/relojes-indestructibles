// Sirve imágenes de productos desde Postgres (BYTEA).
// URL pública: /imagenes/<product_slug>/<filename>
//
// Se monta antes del auth middleware en server.js para que el agente IA y los
// clientes finales puedan ver las imágenes sin cookie.

import express from 'express';
import { getSql } from '../services/db.js';

const router = express.Router();

const SAFE = /^[\w.-]+$/;
function bad(s) {
  return !s || !SAFE.test(s) || s.startsWith('.') || s.includes('..');
}

router.get('/:slug/:filename', async (req, res) => {
  const { slug, filename } = req.params;
  if (bad(slug) || bad(filename)) {
    return res.status(400).send('Invalid path');
  }

  try {
    const sql = getSql();
    const [row] = await sql`
      SELECT content_type, data FROM product_media
      WHERE product_slug = ${slug} AND filename = ${filename}
    `;
    if (row) {
      res.setHeader('Content-Type', row.content_type);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(row.data);
    }
  } catch (err) {
    console.warn('[imagenes] DB query falló:', err.message);
  }

  res.status(404).send('Not found');
});

export default router;
