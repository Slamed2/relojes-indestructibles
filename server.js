import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import productsRouter from './src/routes/products.js';
import imagenesRouter from './src/routes/imagenes.js';
import thumbsRouter from './src/routes/thumbs.js';
import usageRouter from './src/routes/usage.js';
import storiesRouter, { publicGetStoryText, publicPutStoryText, publicGetStoryMedia } from './src/routes/stories.js';
import postsRouter, { publicGetPostText, publicPutPostText, publicGetPostMedia } from './src/routes/posts.js';
import { runMigrations } from './src/services/db.js';
import { startRefreshLoop } from './src/services/exchange-rate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const authEnabled = !!(process.env.AUTH_USER && process.env.AUTH_PASS);
const SECRET =
  process.env.SESSION_SECRET ||
  `${process.env.AUTH_USER || ''}:${process.env.AUTH_PASS || ''}:relojes-indestructibles`;

function signToken(user) {
  const data = `${user}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return `${Buffer.from(data).toString('base64url')}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [dataB64, sig] = token.split('.');
  if (!dataB64 || !sig) return null;
  let data;
  try { data = Buffer.from(dataB64, 'base64url').toString(); } catch { return null; }
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return data.split('.')[0];
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

// === Rutas públicas (antes del auth middleware) ===

// Imágenes de productos.
app.use('/imagenes', imagenesRouter);
app.use('/thumb', thumbsRouter);

// Endpoints públicos para el agente IA externo.
app.get('/api/stories/:id/text', publicGetStoryText);
app.put('/api/stories/:id/text', publicPutStoryText);
app.get('/api/stories/:id/media', publicGetStoryMedia);

app.get('/api/posts/:id/text', publicGetPostText);
app.put('/api/posts/:id/text', publicPutPostText);
app.get('/api/posts/:id/media', publicGetPostMedia);

if (authEnabled) {
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  app.post('/login', (req, res) => {
    const { user, pass } = req.body || {};
    if (user === process.env.AUTH_USER && pass === process.env.AUTH_PASS) {
      const token = signToken(user);
      res.setHeader(
        'Set-Cookie',
        `auth=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`
      );
      return res.json({ ok: true });
    }
    res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  });

  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    if (verifyToken(cookies.auth)) return next();
    if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
    res.status(401).json({ error: 'unauthorized' });
  });
}

// === Rutas privadas (después del auth) ===

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/products', productsRouter);
app.use('/api/usage', usageRouter);
app.use('/api/stories', storiesRouter);
app.use('/api/posts', postsRouter);

app.get('/editor/:slug', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

app.get('/preview', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.get('/usage', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'usage.html'));
});

app.get('/lista', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lista.html'));
});

app.get('/stories', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stories.html'));
});

app.get('/posts', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'posts.html'));
});

if (!authEnabled) {
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
}

app.listen(PORT, async () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      console.log('[db] migraciones OK');
      // Arrancar el loop de refresh de tasa USD→VES (no bloquea boot).
      startRefreshLoop();
    } catch (err) {
      console.error('[db] migraciones fallaron');
      console.error('  message:', err.message || '(vacío)');
      console.error('  code:   ', err.code || '(sin code)');
      console.error('  errno:  ', err.errno || '(sin errno)');
      console.error('  address:', err.address || '(sin address)');
      console.error('  syscall:', err.syscall || '(sin syscall)');
      if (err.cause) console.error('  cause:  ', err.cause);
    }
  } else {
    console.warn('[db] DATABASE_URL no configurada — la app no va a poder leer/escribir productos');
  }
});
