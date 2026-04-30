const slug = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);

const titleInput = $('title');
const priceUsdInput = $('price_usd');
const priceVesInput = $('price_ves');
const slugInput = $('slug');
const descInput = $('description');
const variantsEl = $('variants');
const imagesGeneralEl = $('images-general');
const statusEl = $('status');
const toast = $('toast');

let product = null;

function showToast(msg, err = false) {
  toast.textContent = msg;
  toast.classList.toggle('err', err);
  toast.hidden = false;
  setTimeout(() => toast.hidden = true, 2500);
}

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'save-status ' + type;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// === Formato de precios ===
//
// USD: punto decimal, coma para miles  → "1,234.56"   (en-US)
// VES: coma decimal, punto para miles  → "1.234,56"   (es-VE)
//
// El parse acepta ambos formatos (punto o coma como decimal) para que el
// usuario pueda tipear "1500" o "1.500,00" o "1,500.00" sin pelearse con el
// input. Devuelve número o null.

function parsePrice(s, locale /* 'usd' | 'ves' */) {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  if (locale === 'ves') {
    // Locale es-VE: el punto es separador de miles, la coma es decimal.
    t = t.replace(/\./g, '').replace(',', '.');
  } else {
    // Locale en-US: la coma es separador de miles, el punto es decimal.
    t = t.replace(/,/g, '');
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function formatUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function formatVes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Number(n).toLocaleString('es-VE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

async function load() {
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`);
    if (!r.ok) {
      if (r.status === 404) {
        alert('Producto no encontrado');
        location.href = '/';
        return;
      }
      throw new Error('Error al cargar');
    }
    product = await r.json();
    titleInput.value = product.title || '';
    priceUsdInput.value = formatUsd(product.price_usd);
    priceVesInput.value = formatVes(product.price_ves);
    slugInput.value = product.slug;
    descInput.value = product.description || '';
    renderVariants();
    renderImages();
    // Si hay USD pero no VES, prefill con la tasa actual y marcamos el campo
    // como "auto" para que un cambio futuro de USD lo recalcule en vivo.
    await maybeAutofillVes();
  } catch (err) {
    showToast(err.message, true);
  }
}

// === Auto-cálculo VES en vivo ===
//
// El VES se autocalcula a partir del USD si el campo VES está vacío. Una vez
// el usuario tipea algo distinto en VES, lo dejamos en paz (modo "manual"
// hasta que vacíe el campo de nuevo).

let _ratePromise = null;
function getRate() {
  if (_ratePromise) return _ratePromise;
  _ratePromise = fetch('/api/products/exchange-rate')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return _ratePromise;
}

let vesIsAuto = false; // true cuando el valor en VES lo puso el cálculo, no el usuario.

async function maybeAutofillVes() {
  const usd = parsePrice(priceUsdInput.value, 'usd');
  const vesRaw = priceVesInput.value.trim();
  // Si el usuario ya escribió algo en VES y no es nuestro auto-fill, respetar.
  if (vesRaw !== '' && !vesIsAuto) return;
  if (usd == null || usd <= 0) {
    if (vesIsAuto) { priceVesInput.value = ''; }
    setVesHint('');
    return;
  }
  const rate = await getRate();
  if (!rate?.rate) {
    setVesHint('sin tasa cacheada');
    return;
  }
  const calc = Number((usd * rate.rate).toFixed(2));
  priceVesInput.value = formatVes(calc);
  vesIsAuto = true;
  setVesHint(`auto · Bs. ${formatVes(rate.rate)} / USD`);
}

function setVesHint(text) {
  let hint = document.getElementById('ves-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'ves-hint';
    hint.style.cssText = 'font-size:11px;color:var(--muted);margin-top:-6px;margin-bottom:8px;';
    priceVesInput.parentElement.appendChild(hint);
  }
  hint.textContent = text;
}

// Recalcular VES cuando cambia USD.
priceUsdInput.addEventListener('input', maybeAutofillVes);
// Reformatear USD al perder foco (deja "1500" → "1,500.00").
priceUsdInput.addEventListener('blur', () => {
  const n = parsePrice(priceUsdInput.value, 'usd');
  priceUsdInput.value = n != null ? formatUsd(n) : '';
});
// Si el usuario tipea en VES, salimos del modo auto.
priceVesInput.addEventListener('input', () => {
  vesIsAuto = false;
  setVesHint('');
});
// Reformatear VES al perder foco; si quedó vacío, recalculamos auto.
priceVesInput.addEventListener('blur', () => {
  if (priceVesInput.value.trim() === '') {
    maybeAutofillVes();
    return;
  }
  const n = parsePrice(priceVesInput.value, 'ves');
  priceVesInput.value = n != null ? formatVes(n) : '';
});

// Devuelve el elemento <img>/<video>/<audio> según content_type del media.
function mediaPreview(m) {
  const ct = m.content_type || '';
  if (ct.startsWith('video/')) {
    return `<video src="${escapeHtml(m.url)}" preload="metadata" muted controls></video>`;
  }
  if (ct.startsWith('audio/')) {
    return `<audio src="${escapeHtml(m.url)}" preload="metadata" controls></audio>`;
  }
  return `<img src="${escapeHtml(m.url)}" alt="" loading="lazy" />`;
}

// HTML completo de un tile (preview + botón borrar + textarea con autosave).
function tileHtml(m) {
  return `
    <div class="image-tile" data-id="${m.id}" title="${escapeHtml(m.filename)}">
      <div class="media-frame">
        ${mediaPreview(m)}
        <button class="delete" data-id="${m.id}" title="Borrar">×</button>
      </div>
      <textarea class="caption" data-id="${m.id}"
        placeholder="Descripción de este ${captionKind(m)} (opcional)…"
      >${escapeHtml(m.description || '')}</textarea>
      <span class="caption-status" data-id="${m.id}" hidden></span>
    </div>
  `;
}

function captionKind(m) {
  const ct = m.content_type || '';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'imagen';
}

function renderImages() {
  // Media "general" (variant_id null) — incluye imagen, video y audio.
  const general = product.media.filter((m) => !m.variant_id);
  imagesGeneralEl.innerHTML = general.map(tileHtml).join('');
}

function renderVariants() {
  variantsEl.innerHTML = product.variants.map((v) => {
    const variantImages = product.media.filter((m) => m.variant_id === v.id);
    const imagesHtml = variantImages.map(tileHtml).join('');
    return `
      <div class="variant-card" data-variant-id="${v.id}">
        <div class="field">
          <label>Nombre de variante</label>
          <input class="variant-name" type="text" value="${escapeHtml(v.name)}" />
        </div>
        <div class="field">
          <label>Descripción específica (opcional)</label>
          <textarea class="variant-desc" style="min-height:60px;">${escapeHtml(v.description || '')}</textarea>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);">Imágenes de esta variante</label>
          <div class="images-grid" style="margin-top:6px;">${imagesHtml}</div>
          <label class="upload-tile" style="margin-top:6px; height:50px; aspect-ratio:auto;">
            + Subir media para "${escapeHtml(v.name)}"
            <input type="file" class="upload-variant" data-variant-id="${v.id}" accept="image/*,video/*,audio/*" />
          </label>
        </div>
        <div class="variant-actions">
          <button class="btn btn-save-variant">Guardar variante</button>
          <button class="btn btn-danger btn-del-variant">Eliminar</button>
        </div>
      </div>
    `;
  }).join('');
}

// Guardar producto.
$('btn-save').addEventListener('click', async () => {
  setStatus('Guardando...');
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: titleInput.value.trim(),
        description: descInput.value,
        price_usd: parsePrice(priceUsdInput.value, 'usd'),
        price_ves: parsePrice(priceVesInput.value, 'ves'),
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Error');
    }
    setStatus('Guardado ✓', 'saved');
    setTimeout(() => setStatus(''), 2000);
  } catch (err) {
    setStatus(err.message, 'err');
  }
});

// Eliminar producto.
$('btn-delete').addEventListener('click', async () => {
  if (!confirm('¿Eliminar este producto? Esto borra todas sus imágenes y variantes.')) return;
  const r = await fetch(`/api/products/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  if (r.ok) location.href = '/';
});

// Agregar variante.
$('btn-add-variant').addEventListener('click', async () => {
  const name = prompt('Nombre de la variante:');
  if (!name) return;
  const r = await fetch(`/api/products/${encodeURIComponent(slug)}/variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) { showToast('Error al crear variante', true); return; }
  await load();
});

// Eventos delegados en la zona de variantes.
variantsEl.addEventListener('click', async (ev) => {
  const card = ev.target.closest('.variant-card');
  if (!card) return;
  const variantId = parseInt(card.dataset.variantId, 10);

  if (ev.target.matches('.btn-save-variant')) {
    const name = card.querySelector('.variant-name').value.trim();
    const description = card.querySelector('.variant-desc').value;
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}/variants/${variantId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    if (r.ok) showToast('Variante guardada');
    else showToast('Error', true);
    return;
  }
  if (ev.target.matches('.btn-del-variant')) {
    if (!confirm('¿Borrar esta variante?')) return;
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}/variants/${variantId}`, { method: 'DELETE' });
    if (r.ok) await load();
    return;
  }
  if (ev.target.matches('.image-tile .delete')) {
    const id = parseInt(ev.target.dataset.id, 10);
    if (!confirm('¿Borrar esta imagen?')) return;
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}/images/${id}`, { method: 'DELETE' });
    if (r.ok) await load();
  }
});

// Subida de imagen para variante.
variantsEl.addEventListener('change', async (ev) => {
  if (!ev.target.matches('.upload-variant')) return;
  const file = ev.target.files?.[0];
  if (!file) return;
  const variantId = ev.target.dataset.variantId;
  const fd = new FormData();
  fd.append('image', file);
  fd.append('variant_id', variantId);
  const r = await fetch(`/api/products/${encodeURIComponent(slug)}/images`, {
    method: 'POST',
    body: fd,
  });
  if (r.ok) await load();
  else showToast('Error al subir', true);
});

// Imágenes generales.
imagesGeneralEl.addEventListener('click', async (ev) => {
  if (!ev.target.matches('.image-tile .delete')) return;
  const id = parseInt(ev.target.dataset.id, 10);
  if (!confirm('¿Borrar esta imagen?')) return;
  const r = await fetch(`/api/products/${encodeURIComponent(slug)}/images/${id}`, { method: 'DELETE' });
  if (r.ok) await load();
});

$('upload-general').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  const r = await fetch(`/api/products/${encodeURIComponent(slug)}/images`, {
    method: 'POST',
    body: fd,
  });
  if (r.ok) await load();
  else showToast('Error al subir', true);
});

// === Captions: autosave de la descripción de cada media al perder foco ===

const captionDirty = new WeakMap(); // textarea → último valor guardado

function setCaptionStatus(id, text, type) {
  const el = document.querySelector(`.caption-status[data-id="${id}"]`);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'caption-status' + (type ? ' ' + type : '');
  el.hidden = !text;
}

async function saveCaption(textarea) {
  const id = textarea.dataset.id;
  const value = textarea.value.trim();
  // Si no cambió desde el último save, no hacemos nada.
  if (captionDirty.get(textarea) === value) return;

  setCaptionStatus(id, 'guardando…');
  try {
    const r = await fetch(`/api/products/${encodeURIComponent(slug)}/images/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: value }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'error');
    }
    captionDirty.set(textarea, value);
    // También actualizo el estado en memoria para que un re-render no pierda el valor.
    const m = product.media.find((x) => x.id === parseInt(id, 10));
    if (m) m.description = value;
    setCaptionStatus(id, '✓', 'saved');
    setTimeout(() => setCaptionStatus(id, ''), 1500);
  } catch (err) {
    setCaptionStatus(id, err.message, 'err');
  }
}

function bindCaptionAutosave(rootEl) {
  // focusout burbujea (a diferencia de blur).
  rootEl.addEventListener('focusout', (ev) => {
    if (!ev.target.matches('.caption')) return;
    saveCaption(ev.target);
  });
  // Cmd/Ctrl+Enter dentro del textarea = forzar guardado y salir del foco.
  rootEl.addEventListener('keydown', (ev) => {
    if (!ev.target.matches('.caption')) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      ev.target.blur();
    }
  });
}

bindCaptionAutosave(imagesGeneralEl);
bindCaptionAutosave(variantsEl);

load();
