// Limpia las descripciones de productos quitando URLs de media ya descargadas
// (drive-g.kommo.com y cdnj1.com) y los wrappers que las acompañan, para que
// el editor muestre texto limpio. Las URLs propias del media (servidas desde
// PUBLIC_BASE_URL/imagenes/...) viven ahora en `product_media`, y se inyectan
// en el .md del Vector Store por `buildProductMd` junto a su caption.
//
// Uso:
//   node --env-file=.env scripts/clean-descriptions.mjs --dry        # preview
//   node --env-file=.env scripts/clean-descriptions.mjs              # aplica
//   node --env-file=.env scripts/clean-descriptions.mjs <slug> --dry # un solo producto

import { getSql, closeSql } from '../src/services/db.js';
import { syncProductFile } from '../src/services/products.js';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const ONLY_SLUG = ARGS.find((a) => !a.startsWith('--'));

// Hosts cuyo contenido ya bajamos a product_media — las URLs sueltas a estos
// hosts se vuelven inútiles en la descripción.
const MEDIA_HOST_RE = /drive-g\.kommo\.com|cdnj1\.com/;

// Headers que anuncian una URL inmediatamente después.
const URL_ANNOUNCE_RE = /^\s*(📷|🎧|🎥)\s*\*\*(IMAGEN|AUDIO|VIDEO)\s+DEL\s+PRODUCTO\*\*\s*—.*$/i;

// Wrappers markdown inline que SOLO contienen una URL (ej: `🖼️ ![imagen](URL)`).
function isInlineMediaWrapper(line) {
  if (!MEDIA_HOST_RE.test(line)) return false;
  // Patrón: emoji + (markdown image | markdown link) con la URL dentro.
  return /^\s*(🖼️|🎥|🎧|📷)\s*!?\[[^\]]*\]\(https?:\/\/[^)]+\)\s*$/.test(line);
}

// "Cargando video..." y "_… espera Ns_" son artefactos de pasos sin contenido real.
const NOISE_RE = /^\s*(⏳\s*Cargando\s+video.*|_\s*…\s*espera\s+\d+\w?\s*_)\s*$/i;

function cleanDescription(raw) {
  const lines = raw.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Cortar las secciones "tabla auxiliar" — son fragmentos del importador
    //    que ya no aportan (URLs caducas + tabla de UUIDs).
    //    Acepta el header con o sin '---' previo.
    const trimmed = line.trim();
    const isAuxHeader =
      /^##\s+(URLs\s+mencionadas|Multimedia\s+referenciada)/i.test(trimmed);
    if (isAuxHeader) {
      // Si justo arriba dejamos un '---', borralo también.
      while (out.length && /^---\s*$/.test(out[out.length - 1])) out.pop();
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      // Saltar hasta el próximo '---' (siguiente sección) o EOF.
      i++;
      while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
      // Dejamos el '---' para la próxima iteración (es el separador de la
      // siguiente sección, lo necesitamos preservado). Decrementamos i porque
      // el for++ lo va a re-incrementar.
      i--;
      continue;
    }

    // 2) Línea que solo es una URL de media → fuera.
    if (/^\s*https?:\/\/\S+\s*$/.test(line) && MEDIA_HOST_RE.test(line)) {
      // Si la línea anterior agregada al `out` es un anuncio "envía esta URL...",
      // borramos también ese anuncio.
      while (out.length && URL_ANNOUNCE_RE.test(out[out.length - 1])) out.pop();
      // Si justo antes había una línea vacía y ahora ya no hay anuncio que
      // sostenerla, también la podamos.
      while (out.length >= 2 && out[out.length - 1].trim() === '' &&
             URL_ANNOUNCE_RE.test(out[out.length - 2] || '')) {
        out.pop(); out.pop();
      }
      continue;
    }

    // 3) Wrapper inline (🖼️ ![imagen](URL), 🎥 [video](URL), 🎧 [audio](URL)).
    if (isInlineMediaWrapper(line)) continue;

    // 4) Ruido tipo "Cargando video...", "_… espera 6s_".
    if (NOISE_RE.test(line)) continue;

    out.push(line);
  }

  // Colapsar 3+ líneas vacías → 2 (deja "doble salto" como párrafo, no más).
  let s = out.join('\n').replace(/\n{3,}/g, '\n\n');
  // Trim final de líneas vacías.
  s = s.replace(/\s+$/g, '') + '\n';
  return s;
}

function diffStats(before, after) {
  const b = before.split('\n').length;
  const a = after.split('\n').length;
  // contamos URLs eliminadas
  const urlsBefore = (before.match(/https?:\/\/\S+/g) || []).filter(u => MEDIA_HOST_RE.test(u)).length;
  const urlsAfter  = (after.match(/https?:\/\/\S+/g)  || []).filter(u => MEDIA_HOST_RE.test(u)).length;
  return { lineDiff: b - a, urlsRemoved: urlsBefore - urlsAfter };
}

async function main() {
  const sql = getSql();
  const rows = ONLY_SLUG
    ? await sql`SELECT slug, title, description FROM products WHERE slug = ${ONLY_SLUG}`
    : await sql`SELECT slug, title, description FROM products ORDER BY slug`;

  console.log(`Procesando ${rows.length} producto(s)${DRY ? ' (DRY RUN)' : ''}\n`);

  let touched = 0;
  let totalLines = 0;
  let totalUrls = 0;

  for (const p of rows) {
    const next = cleanDescription(p.description);
    if (next === p.description) {
      console.log(`  ${p.slug}: sin cambios`);
      continue;
    }
    const stats = diffStats(p.description, next);
    totalLines += stats.lineDiff;
    totalUrls += stats.urlsRemoved;
    touched++;

    console.log(`\n[${p.slug}]`);
    console.log(`  -${stats.lineDiff} líneas, -${stats.urlsRemoved} URLs de media`);

    if (DRY && rows.length === 1) {
      // Si solo procesamos uno y es dry, mostramos el resultado completo.
      console.log('\n--- AFTER ---');
      console.log(next);
      console.log('--- /AFTER ---');
    }

    if (!DRY) {
      await sql`
        UPDATE products SET description = ${next}, updated_at = now()
        WHERE slug = ${p.slug}
      `;
    }
  }

  console.log(`\n=========================`);
  console.log(`Limpiados: ${touched}/${rows.length} productos`);
  console.log(`Total: -${totalLines} líneas, -${totalUrls} URLs`);

  if (!DRY && touched > 0) {
    console.log(`\nRe-sincronizando al VS...`);
    for (const p of rows) {
      try {
        await syncProductFile(p.slug);
        console.log(`  ✓ ${p.slug}`);
      } catch (err) {
        console.log(`  ✗ ${p.slug}: ${err.message}`);
      }
    }
  }

  await closeSql();
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
