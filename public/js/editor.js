const slug = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);

const titleInput = $('title');
const priceInput = $('price');
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
    priceInput.value = product.price ?? '';
    slugInput.value = product.slug;
    descInput.value = product.description || '';
    renderVariants();
    renderImages();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderImages() {
  // Imágenes "generales" (variant_id null)
  const general = product.media.filter((m) => !m.variant_id);
  imagesGeneralEl.innerHTML = general.map((img) => `
    <div class="image-tile" data-id="${img.id}">
      <img src="${escapeHtml(img.url)}" alt="" loading="lazy" />
      <button class="delete" data-id="${img.id}" title="Borrar">×</button>
    </div>
  `).join('');
}

function renderVariants() {
  variantsEl.innerHTML = product.variants.map((v) => {
    const variantImages = product.media.filter((m) => m.variant_id === v.id);
    const imagesHtml = variantImages.map((img) => `
      <div class="image-tile" data-id="${img.id}">
        <img src="${escapeHtml(img.url)}" alt="" loading="lazy" />
        <button class="delete" data-id="${img.id}" title="Borrar">×</button>
      </div>
    `).join('');
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
            + Subir imagen para "${escapeHtml(v.name)}"
            <input type="file" class="upload-variant" data-variant-id="${v.id}" accept="image/*" />
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
        price: priceInput.value ? parseFloat(priceInput.value) : null,
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

load();
