const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const noResults = document.getElementById('no-results');
const btnNuevo = document.getElementById('btn-nuevo');
const dlg = document.getElementById('dlg-nuevo');
const nuevoTitle = document.getElementById('nuevo-title');
const masterInfo = document.getElementById('master-info');
const searchInput = document.getElementById('search');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim();
}

let allProducts = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function fmtPrices(p) {
  const parts = [];
  if (p.price_usd != null) parts.push('USD $' + Number(p.price_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  if (p.price_ves != null) parts.push('Bs. ' + Number(p.price_ves).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return parts.join(' · ');
}

// Convierte URLs de /imagenes/<slug>/<file> a su versión thumb si es del mismo origen.
function toThumbUrl(url, width = 480) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.origin !== location.origin) return url;
    } catch { return url; }
  }
  const m = url.match(/\/imagenes\/([^?#]+)/);
  if (!m) return url;
  const parts = m[1].split('/').map(encodeURIComponent).join('/');
  return `/thumb/${parts}?w=${width}`;
}

function renderGrid(products) {
  grid.innerHTML = '';
  if (!products.length) {
    grid.hidden = true;
    return;
  }
  grid.hidden = false;
  for (const p of products) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `/editor/${encodeURIComponent(p.slug)}`;
    const img = p.image
      ? `<img src="${toThumbUrl(p.image, 480)}" alt="" loading="lazy" decoding="async" />`
      : '<span>Sin imagen</span>';
    const priceTxt = fmtPrices(p) || (p.updated_at ? new Date(p.updated_at).toLocaleString() : '');
    card.innerHTML = `
      <div class="card-img">${img}</div>
      <div class="card-body">
        <h3>${escapeHtml(p.title)}</h3>
        <small>${priceTxt}</small>
      </div>`;
    grid.appendChild(card);
  }
}

function applyFilter() {
  const q = normalize(searchInput?.value);
  empty.hidden = allProducts.length > 0;
  if (!allProducts.length) {
    grid.innerHTML = '';
    grid.hidden = true;
    noResults.hidden = true;
    return;
  }
  if (!q) {
    renderGrid(allProducts);
    noResults.hidden = true;
    return;
  }
  const filtered = allProducts.filter((p) =>
    normalize(p.title).includes(q) || normalize(p.slug).includes(q)
  );
  renderGrid(filtered);
  noResults.hidden = filtered.length > 0;
}

async function load() {
  const r = await fetch('/api/products');
  const data = await r.json();
  allProducts = data.products || [];
  if (masterInfo) {
    masterInfo.textContent = allProducts.length
      ? `${allProducts.length} producto${allProducts.length === 1 ? '' : 's'}`
      : 'Sin productos. Creá uno nuevo.';
  }
  applyFilter();
}

searchInput?.addEventListener('input', applyFilter);

btnNuevo.addEventListener('click', () => {
  nuevoTitle.value = '';
  dlg.showModal();
});

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'default') return;
  const title = nuevoTitle.value.trim();
  if (!title) return;
  const r = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Error al crear');
    return;
  }
  const { slug } = await r.json();
  location.href = `/editor/${encodeURIComponent(slug)}`;
});

load();
