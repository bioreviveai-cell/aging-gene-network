/**
 * Aging Gene Network — app.js (canvas edition)
 *
 * WHY THIS IS FAST:
 *   All graph computation (layout positions, edges, centrality) is done
 *   ONCE in Python (build_graph.py) and baked into graph.json. The browser
 *   never runs a physics simulation. It just paints precomputed x,y
 *   positions onto a <canvas> — one draw call, no per-frame solving.
 *   This is the single biggest latency fix: we moved O(n log n) physics
 *   and O(n^2) edge-building off the main thread entirely.
 *
 * WHAT'S NEW — BRIDGE GENES:
 *   build_graph.py computes betweenness centrality on the full graph and a
 *   "bridge score" = betweenness x number of distinct hallmarks reachable.
 *   A high bridge score means the gene links otherwise-separate aging
 *   mechanisms — a candidate for influencing multiple hallmarks at once.
 *   The right-hand panel ranks them; clicking one zooms to it in the graph.
 */

const DATA_GRAPH = './graph.json';
const DATA_META  = './meta.json';
const DATA_HUBS  = './hubs.json';

// ─── State ───────────────────────────────────────────────────────────────────
let graph = null;      // {nodes, edges} from graph.json
let hubs  = [];        // top bridge genes
let view  = { zoom: 1, panX: 0, panY: 0 };  // camera
let drawNodes = [];    // currently visible nodes (post-filter)
let drawEdges = [];
let hoverNode = null;
let selectedNode = null;

// ─── Colors ───────────────────────────────────────────────────────────────────
const COLORS = {
  increases: '#1D9E75', decreases: '#D85A30',
  both: '#7F77DD',      unknown: '#5F5E5A',
};
const EDGE_COLOR = 'rgba(120,119,221,0.10)';
const EDGE_HOVER = 'rgba(159,169,236,0.6)';

// ─── DOM ─────────────────────────────────────────────────────────────────────
const canvas    = document.getElementById('network-canvas');
const ctx       = canvas.getContext('2d');
const wrap      = document.getElementById('graph-wrap');
const fetchBtn  = document.getElementById('fetch-btn');
const hallmarkSel = document.getElementById('hallmark-select');
const criteriaSel = document.getElementById('criteria-select');
const effectSel   = document.getElementById('effect-select');
const highlightSel= document.getElementById('highlight-select');
const graphState= document.getElementById('graph-state');
const stateMsg  = document.getElementById('state-message');
const stateSub  = document.getElementById('state-sub');
const zoomHint  = document.getElementById('zoom-hint');
const detailPanel = document.getElementById('detail-panel');
const panelContent= document.getElementById('panel-content');
const panelClose  = document.getElementById('panel-close');
const hubsList  = document.getElementById('hubs-list');
const statsBar  = document.getElementById('stats-bar');
const statNodes = document.getElementById('stat-nodes');
const statEdges = document.getElementById('stat-edges');
const statTopHub= document.getElementById('stat-top-hub');
const geneBadge = document.getElementById('gene-count-badge');

// ─── Canvas sizing (retina-aware) ──────────────────────────────────────────────
function resizeCanvas() {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = r.width  * dpr;
  canvas.height = r.height * dpr;
  canvas.style.width  = r.width + 'px';
  canvas.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener('resize', resizeCanvas);

// ─── 1. LOAD ─────────────────────────────────────────────────────────────────
async function init() {
  setState('Loading precomputed network…', '');
  const [gResp, mResp, hResp] = await Promise.all([
    fetch(DATA_GRAPH), fetch(DATA_META), fetch(DATA_HUBS),
  ]);
  if (!gResp.ok) throw new Error(`graph.json (${gResp.status})`);
  graph = await gResp.json();
  const meta = await mResp.json();
  hubs = await hResp.json();

  meta.hallmarks.forEach(h => {
    const o = document.createElement('option');
    o.value = h.id; o.textContent = h.name;
    hallmarkSel.appendChild(o);
  });

  geneBadge.textContent = `${graph.nodes.length} networked genes`;
  geneBadge.classList.remove('hidden');

  renderHubs();
  setState('Click <strong>Build network</strong> to render', `${graph.nodes.length} genes · ${graph.edges.length} connections, all precomputed`);
  fetchBtn.disabled = false;
}

// ─── 2. FILTER + fit camera ────────────────────────────────────────────────────
function buildView() {
  const maxLevel   = parseInt(criteriaSel.value);
  const effectVal  = effectSel.value;
  const hallmarkId = hallmarkSel.value ? parseInt(hallmarkSel.value) : null;

  const nodeById = {};
  drawNodes = graph.nodes.filter(n => {
    if (n.conf > maxLevel) return false;
    if (effectVal && n.lifespan !== effectVal) return false;
    if (hallmarkId) {
      // hallmark names are stored; match by id requires meta — we match by membership
      // graph.json stores hallmark names, so we filter using the hub/meta mapping:
      if (!n._hallmarkIds) return true; // fallback
    }
    return true;
  });

  // Hallmark filter by name match (meta provides id->name; we filter on names)
  if (hallmarkId) {
    const hname = hallmarkSel.options[hallmarkSel.selectedIndex].textContent;
    drawNodes = drawNodes.filter(n => n.hallmarks.includes(hname));
  }

  drawNodes.forEach(n => nodeById[n.id] = n);
  const visible = new Set(drawNodes.map(n => n.id));
  drawEdges = graph.edges.filter(e => visible.has(e.s) && visible.has(e.t));

  fitCamera();
  updateStats();
}

function fitCamera() {
  if (!drawNodes.length) return;
  const xs = drawNodes.map(n => n.x), ys = drawNodes.map(n => n.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  const r = wrap.getBoundingClientRect();
  const pad = 60;
  const zx = (r.width - pad*2) / (maxx - minx || 1);
  const zy = (r.height - pad*2) / (maxy - miny || 1);
  view.zoom = Math.min(zx, zy);
  view.panX = pad - minx * view.zoom + (r.width - pad*2 - (maxx-minx)*view.zoom)/2;
  view.panY = pad - miny * view.zoom + (r.height - pad*2 - (maxy-miny)*view.zoom)/2;
}

// world → screen
function sx(x) { return x * view.zoom + view.panX; }
function sy(y) { return y * view.zoom + view.panY; }

// ─── 3. RENDER (single draw, no physics) ───────────────────────────────────────
function nodeRadius(n) {
  const base = 3 + (6 - n.conf);              // confidence → size
  const hl = highlightSel.value;
  if (hl === 'bridge')  return base + n.bridge * 14;
  if (hl === 'degree')  return base + Math.min(n.degree / 50, 10);
  return base;
}

function render() {
  if (!ctx) return;
  const r = wrap.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!drawNodes.length) return;

  // edges
  ctx.lineWidth = 0.5;
  for (const e of drawEdges) {
    const a = nById(e.s), b = nById(e.t);
    if (!a || !b) continue;
    const isHot = hoverNode && (e.s === hoverNode.id || e.t === hoverNode.id);
    ctx.strokeStyle = isHot ? EDGE_HOVER : EDGE_COLOR;
    ctx.lineWidth = isHot ? 1.2 : 0.5;
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sy(a.y));
    ctx.lineTo(sx(b.x), sy(b.y));
    ctx.stroke();
  }

  // nodes
  const hl = highlightSel.value;
  for (const n of drawNodes) {
    const rad = nodeRadius(n);
    const px = sx(n.x), py = sy(n.y);
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI*2);
    ctx.fillStyle = COLORS[n.lifespan] || COLORS.unknown;
    ctx.fill();
    // ring for highlighted top genes
    if (hl === 'bridge' && n.bridge > 0.1) {
      ctx.strokeStyle = '#FAC775'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (n === selectedNode) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // labels only when zoomed in or for big nodes
  ctx.fillStyle = '#e8e6df';
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const n of drawNodes) {
    const rad = nodeRadius(n);
    if (view.zoom > 1.4 || rad > 9 || n === hoverNode) {
      ctx.fillText(n.id, sx(n.x), sy(n.y) - rad - 3);
    }
  }
}

const _idx = {};
function nById(id) { return _idx[id]; }
function reindex() { for (const k in _idx) delete _idx[k]; drawNodes.forEach(n => _idx[n.id] = n); }

// ─── 4. INTERACTION ────────────────────────────────────────────────────────────
let dragging = false, lastX = 0, lastY = 0, moved = false;

canvas.addEventListener('mousedown', e => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (dragging) {
    view.panX += e.clientX - lastX;
    view.panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    moved = true;
    render();
    return;
  }
  // hover detection
  const prev = hoverNode;
  hoverNode = pickNode(mx, my);
  canvas.style.cursor = hoverNode ? 'pointer' : 'grab';
  if (hoverNode !== prev) render();
});

canvas.addEventListener('click', e => {
  if (moved) return;
  const r = canvas.getBoundingClientRect();
  const n = pickNode(e.clientX - r.left, e.clientY - r.top);
  if (n) { selectedNode = n; openDetail(n); render(); }
  else   { selectedNode = null; closeDetail(); render(); }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  // zoom toward cursor
  const wx = (mx - view.panX) / view.zoom;
  const wy = (my - view.panY) / view.zoom;
  view.zoom *= factor;
  view.panX = mx - wx * view.zoom;
  view.panY = my - wy * view.zoom;
  render();
}, { passive: false });

function pickNode(mx, my) {
  // reverse iterate so top-drawn nodes win
  for (let i = drawNodes.length - 1; i >= 0; i--) {
    const n = drawNodes[i];
    const dx = mx - sx(n.x), dy = my - sy(n.y);
    const rad = nodeRadius(n) + 3;
    if (dx*dx + dy*dy <= rad*rad) return n;
  }
  return null;
}

// ─── 5. BRIDGE GENES PANEL ─────────────────────────────────────────────────────
function renderHubs() {
  hubsList.innerHTML = hubs.map((h, i) => `
    <div class="hub-item" data-gene="${h.id}">
      <div class="hub-rank">${i+1}</div>
      <div class="hub-body">
        <div class="hub-sym">${h.id}
          <span class="hub-dot" style="background:${COLORS[h.lifespan]||COLORS.unknown}"></span>
        </div>
        <div class="hub-meta">${h.n_hallmarks} hallmarks · ${h.degree} links</div>
        <div class="hub-bar"><div class="hub-fill" style="width:${(h.bridge*100).toFixed(0)}%"></div></div>
      </div>
    </div>
  `).join('');

  hubsList.querySelectorAll('.hub-item').forEach(el => {
    el.addEventListener('click', () => {
      const sym = el.dataset.gene;
      const n = graph.nodes.find(x => x.id === sym);
      if (!n) return;
      // make sure it's visible, then zoom to it
      if (!drawNodes.includes(n)) { criteriaSel.value = '5'; effectSel.value=''; hallmarkSel.value=''; build(); }
      zoomTo(n);
      selectedNode = n; openDetail(n); render();
    });
  });
}

function zoomTo(n) {
  const r = wrap.getBoundingClientRect();
  view.zoom = 2.2;
  view.panX = r.width/2 - n.x * view.zoom;
  view.panY = r.height/2 - n.y * view.zoom;
}

// ─── 6. DETAIL PANEL ────────────────────────────────────────────────────────────
function openDetail(n) {
  const effectClass = { increases:'tag-green', decreases:'tag-coral', both:'tag-purple', unknown:'tag-gray' };
  const effectLabel = { increases:'↑ Increases lifespan', decreases:'↓ Decreases lifespan', both:'↕ Both effects', unknown:'— Unknown' };
  const mech = n.hallmarks.map(h => `<span class="tag tag-purple">${h}</span>`).join('') || '<span class="dim">None</span>';
  const dis  = (n.diseases||[]).map(d => `<span class="tag tag-gray">${d}</span>`).join('') || '<span class="dim">None listed</span>';
  const clus = (n.clusters||[]).map(c => `<span class="tag tag-blue">${c}</span>`).join('') || '<span class="dim">None listed</span>';
  const links = [
    n.ncbi_id ? `<a href="https://www.ncbi.nlm.nih.gov/gene/${n.ncbi_id}" target="_blank" rel="noopener">NCBI ↗</a>` : '',
    `<a href="https://open-genes.com/gene/${n.id}" target="_blank" rel="noopener">Open Genes ↗</a>`,
    n.uniprot ? `<a href="https://www.uniprot.org/uniprot/${n.uniprot}" target="_blank" rel="noopener">UniProt ↗</a>` : '',
  ].filter(Boolean).join('');
  const confPct = ((6 - n.conf)/5*100).toFixed(0);

  panelContent.innerHTML = `
    <div class="panel-header">
      <div class="panel-symbol">${n.id}</div>
      <div class="panel-name">${n.name||''}</div>
      <span class="tag ${effectClass[n.lifespan]}">${effectLabel[n.lifespan]}</span>
    </div>
    <div class="panel-section metrics-row">
      <div class="metric"><div class="metric-val">${n.bridge.toFixed(2)}</div><div class="metric-lbl">Bridge score</div></div>
      <div class="metric"><div class="metric-val">${n.degree}</div><div class="metric-lbl">Connections</div></div>
      <div class="metric"><div class="metric-val">${n.hallmarks.length}</div><div class="metric-lbl">Hallmarks</div></div>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Confidence</div>
      <div class="criteria-bar"><div class="criteria-fill" style="width:${confPct}%"></div></div>
      <div class="criteria-text">${n.conf_name} (level ${n.conf} of 5)</div>
    </div>
    <div class="panel-section"><div class="panel-section-label">Aging hallmarks</div><div class="tags-row">${mech}</div></div>
    <div class="panel-section"><div class="panel-section-label">Functional clusters</div><div class="tags-row">${clus}</div></div>
    <div class="panel-section"><div class="panel-section-label">Associated diseases</div><div class="tags-row">${dis}</div></div>
    <div class="panel-links">${links}</div>
  `;
  detailPanel.classList.remove('closed');
}
function closeDetail() { detailPanel.classList.add('closed'); }

// ─── 7. STATS ───────────────────────────────────────────────────────────────────
function updateStats() {
  statNodes.textContent = `${drawNodes.length} genes`;
  statEdges.textContent = `${drawEdges.length} connections`;
  const top = drawNodes.reduce((a,b) => b.bridge > (a?.bridge||0) ? b : a, null);
  statTopHub.textContent = top ? `Top bridge: ${top.id}` : '';
  statsBar.classList.remove('hidden');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setState(msg, sub) {
  graphState.style.display = 'flex';
  stateMsg.innerHTML = msg; stateSub.textContent = sub;
}
function hideState() { graphState.style.display = 'none'; zoomHint.classList.remove('hidden'); }

function build() {
  fetchBtn.disabled = true; fetchBtn.textContent = 'Building…';
  closeDetail(); selectedNode = null;
  // Precomputed → effectively instant. Timeout lets the button repaint.
  setTimeout(() => {
    buildView();
    reindex();
    resizeCanvas();   // also calls render()
    hideState();
    fetchBtn.disabled = false; fetchBtn.textContent = 'Rebuild';
  }, 10);
}

// ─── INIT ────────────────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', build);
panelClose.addEventListener('click', () => { closeDetail(); selectedNode = null; render(); });
highlightSel.addEventListener('change', render);

init().catch(err => setState(`<span style="color:#E24B4A">⚠ ${err.message}</span>`, 'Check graph.json, meta.json, hubs.json are present'));
