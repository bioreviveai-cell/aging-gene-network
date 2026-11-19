/**
 * Aging Gene Network — app.js
 *
 * DATA SOURCE: genes.json + meta.json (generated from Open Genes SQL dump)
 * These are static files in the same directory, so the tool works
 * with zero API calls and zero backend.
 *
 * HOW IT WORKS:
 * 1. LOAD    → fetch genes.json and meta.json on page load
 * 2. FILTER  → user picks hallmark / confidence / lifespan effect
 * 3. EDGES   → two genes share an edge if they share an aging hallmark
 * 4. RENDER  → vis-network draws the force-directed graph
 * 5. DETAIL  → click any node to see the full gene card
 *
 * CONFIDENCE LEVELS (from Open Genes):
 *   1 = highest  2 = high  3 = moderate  4 = low  5 = lowest
 *
 * LIFESPAN VALUES: 'increases' | 'decreases' | 'both' | 'unknown'
 */

// ─── API / data paths ────────────────────────────────────────────────────────
const DATA_GENES = './genes.json';
const DATA_META  = './meta.json';

// ─── State ───────────────────────────────────────────────────────────────────
let network      = null;
let allGenes     = [];
let nodesDataset = null;
let edgesDataset = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const fetchBtn    = document.getElementById('fetch-btn');
const hallmarkSel = document.getElementById('hallmark-select');
const criteriaSel = document.getElementById('criteria-select');
const effectSel   = document.getElementById('effect-select');
const limitSel    = document.getElementById('limit-select');
const networkDiv  = document.getElementById('network');
const graphState  = document.getElementById('graph-state');
const stateMsg    = document.getElementById('state-message');
const stateSub    = document.getElementById('state-sub');
const detailPanel = document.getElementById('detail-panel');
const panelContent= document.getElementById('panel-content');
const panelClose  = document.getElementById('panel-close');
const statsBar    = document.getElementById('stats-bar');
const statNodes   = document.getElementById('stat-nodes');
const statEdges   = document.getElementById('stat-edges');
const statTopHub  = document.getElementById('stat-top-hub');
const geneBadge   = document.getElementById('gene-count-badge');

// ─── Colors ───────────────────────────────────────────────────────────────────
const COLORS = {
  increases: { bg: '#1D9E75', border: '#0F6E56' },
  decreases: { bg: '#D85A30', border: '#993C1D' },
  both:      { bg: '#7F77DD', border: '#534AB7' },
  unknown:   { bg: '#5F5E5A', border: '#444441' },
};

// ─── 1. BOOTSTRAP ─────────────────────────────────────────────────────────────
async function init() {
  setLoadingState('Loading gene database…', '');

  const [genesResp, metaResp] = await Promise.all([
    fetch(DATA_GENES),
    fetch(DATA_META),
  ]);

  if (!genesResp.ok) throw new Error(`Could not load genes.json (${genesResp.status})`);
  if (!metaResp.ok)  throw new Error(`Could not load meta.json (${metaResp.status})`);

  allGenes = await genesResp.json();
  const meta = await metaResp.json();

  // Populate hallmark dropdown from meta.json
  meta.hallmarks.forEach(h => {
    const opt = document.createElement('option');
    opt.value = h.id;
    opt.textContent = h.name;
    hallmarkSel.appendChild(opt);
  });

  // Update the confidence dropdown labels to match Open Genes naming
  criteriaSel.innerHTML = `
    <option value="">Any confidence</option>
    <option value="1">Highest only</option>
    <option value="2" selected>High or above</option>
    <option value="3">Moderate or above</option>
    <option value="5">All genes</option>
  `;

  geneBadge.textContent = `${allGenes.length} genes loaded`;
  geneBadge.classList.remove('hidden');

  // Reset to idle state
  graphState.style.display = 'flex';
  stateMsg.innerHTML = 'Choose filters and click <strong>Build network</strong>';
  stateSub.textContent = `${allGenes.length} aging genes loaded from database`;
  networkDiv.style.opacity = '1';
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Build network';
}

// ─── 2. FILTER ───────────────────────────────────────────────────────────────
function filterGenes() {
  const maxLevel   = criteriaSel.value ? parseInt(criteriaSel.value) : 5;
  const effectVal  = effectSel.value;
  const hallmarkId = hallmarkSel.value ? parseInt(hallmarkSel.value) : null;
  const limit      = parseInt(limitSel.value);

  let filtered = allGenes.filter(gene => {
    // Confidence: level 1=highest, 5=lowest. maxLevel means "this level or better"
    if (gene.confidence_level > maxLevel) return false;

    // Lifespan
    if (effectVal && gene.lifespan !== effectVal) return false;

    // Hallmark
    if (hallmarkId) {
      const has = gene.agingMechanisms.some(m => m.id === hallmarkId);
      if (!has) return false;
    }

    return true;
  });

  // Already sorted by confidence; take top N
  return filtered.slice(0, limit);
}

// ─── 3. BUILD EDGES ──────────────────────────────────────────────────────────
function buildNetwork(genes) {
  /*
   * TEACHING NOTE — edge logic:
   * Two genes are connected if they share ≥1 aging hallmark (mechanism).
   * Edge weight = number of shared hallmarks.
   * We cap edges per node (MAX_EDGES) to keep the graph readable.
   */
  const MAX_EDGES = 10;

  // hallmark_id → [gene symbols]
  const hallmarkMap = {};
  genes.forEach(gene => {
    gene.agingMechanisms.forEach(m => {
      if (!hallmarkMap[m.id]) hallmarkMap[m.id] = [];
      hallmarkMap[m.id].push(gene.symbol);
    });
  });

  // Count shared hallmarks for each gene pair
  const pairCount = {};
  Object.values(hallmarkMap).forEach(symbols => {
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const key = [symbols[i], symbols[j]].sort().join('|||');
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  });

  // Build edges, respecting per-node cap
  const edgeCount = {};
  const edges = [];
  // Sort by shared count descending so strongest edges get priority
  const sortedPairs = Object.entries(pairCount).sort((a,b) => b[1]-a[1]);
  for (const [key, count] of sortedPairs) {
    const [a, b] = key.split('|||');
    if ((edgeCount[a]||0) >= MAX_EDGES || (edgeCount[b]||0) >= MAX_EDGES) continue;
    edgeCount[a] = (edgeCount[a]||0) + 1;
    edgeCount[b] = (edgeCount[b]||0) + 1;
    edges.push({ from: a, to: b, value: count });
  }

  // Build nodes
  const nodes = genes.map(gene => {
    const c = COLORS[gene.lifespan] || COLORS.unknown;
    // Node size based on confidence (level 1=best → bigger node)
    const sizeScore = 6 - gene.confidence_level; // 1→5, 5→1
    return {
      id:    gene.symbol,
      label: gene.symbol,
      title: `<div style="font:12px system-ui;padding:4px 6px;max-width:180px">
                <strong>${gene.symbol}</strong><br>
                <span style="color:#888">${gene.name||''}</span><br>
                Confidence: ${gene.confidence_name}<br>
                Lifespan: ${gene.lifespan}
              </div>`,
      value: sizeScore,
      color: { background: c.bg, border: c.border,
               highlight: { background: c.bg, border: '#fff' },
               hover:      { background: c.bg, border: '#fff' } },
      font:  { color: '#ffffff', size: 11, face: 'Inter, system-ui, sans-serif' },
      _raw:  gene,
    };
  });

  return { nodes, edges };
}

// ─── 4. RENDER ───────────────────────────────────────────────────────────────
function renderNetwork(nodes, edges) {
  if (network) { network.destroy(); network = null; }

  nodesDataset = new vis.DataSet(nodes);
  edgesDataset = new vis.DataSet(edges);

  const options = {
    nodes: {
      shape: 'dot',
      scaling: { min: 10, max: 38 },
      borderWidth: 1.5,
    },
    edges: {
      scaling: { min: 0.5, max: 5 },
      color: { color: '#2a2d33', highlight: '#888780', hover: '#5F5E5A' },
      smooth: { type: 'continuous' },
    },
    physics: {
      barnesHut: {
        gravitationalConstant: -4500,
        centralGravity: 0.25,
        springLength: 130,
        springConstant: 0.04,
        damping: 0.09,
      },
      stabilization: { iterations: 300, updateInterval: 20 },
    },
    interaction: { hover: true, tooltipDelay: 150 },
  };

  network = new vis.Network(
    networkDiv,
    { nodes: nodesDataset, edges: edgesDataset },
    options
  );

  network.on('stabilizationProgress', p => {
    const pct = Math.round(p.iterations / p.total * 100);
    stateMsg.textContent = `Laying out network… ${pct}%`;
  });

  network.on('stabilizationIterationsDone', () => {
    graphState.style.display = 'none';
    networkDiv.style.opacity = '1';
    updateStats(nodes, edges);
  });

  network.on('click', params => {
    if (params.nodes.length > 0) {
      openDetailPanel(nodesDataset.get(params.nodes[0]));
    } else {
      closeDetailPanel();
    }
  });
}

// ─── 5. STATS ─────────────────────────────────────────────────────────────────
function updateStats(nodes, edges) {
  const deg = {};
  edges.forEach(e => {
    deg[e.from] = (deg[e.from]||0) + 1;
    deg[e.to]   = (deg[e.to]  ||0) + 1;
  });
  let topHub = null, topDeg = 0;
  Object.entries(deg).forEach(([s,d]) => { if (d > topDeg) { topDeg=d; topHub=s; }});

  statNodes.textContent  = `${nodes.length} genes`;
  statEdges.textContent  = `${edges.length} connections`;
  statTopHub.textContent = topHub ? `Top hub: ${topHub} (${topDeg})` : '';
  statsBar.classList.remove('hidden');
}

// ─── 6. DETAIL PANEL ─────────────────────────────────────────────────────────
function openDetailPanel(nodeData) {
  const g = nodeData._raw;
  if (!g) return;

  const effectClass = { increases:'tag-green', decreases:'tag-coral', both:'tag-purple', unknown:'tag-gray' };
  const effectLabel = { increases:'↑ Increases lifespan', decreases:'↓ Decreases lifespan', both:'↕ Both effects', unknown:'— Unknown' };

  const mechHTML = g.agingMechanisms.map(m =>
    `<span class="tag tag-purple">${m.name}</span>`).join('') || '<span class="dim">None</span>';

  const diseaseHTML = g.diseases.map(d =>
    `<span class="tag tag-gray">${d}</span>`).join('') || '<span class="dim">None listed</span>';

  const clusterHTML = g.functionalClusters.map(c =>
    `<span class="tag tag-blue">${c}</span>`).join('') || '<span class="dim">None listed</span>';

  const links = [
    g.ncbi_id  ? `<a href="https://www.ncbi.nlm.nih.gov/gene/${g.ncbi_id}" target="_blank" rel="noopener">NCBI ↗</a>` : '',
    `<a href="https://open-genes.com/gene/${g.symbol}" target="_blank" rel="noopener">Open Genes ↗</a>`,
    g.uniprot  ? `<a href="https://www.uniprot.org/uniprot/${g.uniprot}" target="_blank" rel="noopener">UniProt ↗</a>` : '',
    g.ensembl  ? `<a href="https://ensembl.org/Homo_sapiens/Gene/Summary?g=${g.ensembl}" target="_blank" rel="noopener">Ensembl ↗</a>` : '',
  ].filter(Boolean).join('');

  // Confidence bar: level 1=100%, 5=20%
  const confPct = ((6 - g.confidence_level) / 5 * 100).toFixed(0);

  panelContent.innerHTML = `
    <div class="panel-header">
      <div class="panel-symbol">${g.symbol}</div>
      <div class="panel-name">${g.name || g.aliases || ''}</div>
      <span class="tag ${effectClass[g.lifespan]}">${effectLabel[g.lifespan]}</span>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Confidence</div>
      <div class="criteria-bar"><div class="criteria-fill" style="width:${confPct}%"></div></div>
      <div class="criteria-text">${g.confidence_name} (level ${g.confidence_level} of 5)</div>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Aging hallmarks</div>
      <div class="tags-row">${mechHTML}</div>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Functional clusters</div>
      <div class="tags-row">${clusterHTML}</div>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Associated diseases</div>
      <div class="tags-row">${diseaseHTML}</div>
    </div>
    <div class="panel-links">${links}</div>
  `;
  detailPanel.classList.remove('closed');
}

function closeDetailPanel() { detailPanel.classList.add('closed'); }

// ─── Loading states ───────────────────────────────────────────────────────────
function setLoadingState(msg, sub) {
  graphState.style.display = 'flex';
  stateMsg.innerHTML = msg;
  stateSub.textContent = sub;
  networkDiv.style.opacity = '0.2';
}

function setErrorState(msg) {
  graphState.style.display = 'flex';
  stateMsg.innerHTML = `<span style="color:#E24B4A">⚠ ${msg}</span>`;
  stateSub.textContent = 'Check that genes.json and meta.json are in the same folder';
  networkDiv.style.opacity = '1';
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Build network';
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleBuild() {
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Building…';
  statsBar.classList.add('hidden');
  closeDetailPanel();
  setLoadingState('Filtering genes…', '');

  const filtered = filterGenes();
  if (filtered.length === 0) {
    setErrorState('No genes match these filters. Try relaxing confidence or effect filters.');
    return;
  }

  setLoadingState(`Building network for ${filtered.length} genes…`, '');
  const { nodes, edges } = buildNetwork(filtered);

  setLoadingState('Rendering…', '');
  renderNetwork(nodes, edges);

  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Rebuild';
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function injectLegend() {
  const l = document.createElement('div');
  l.className = 'legend';
  l.innerHTML = `
    <div class="legend-item"><span class="legend-dot" style="background:#1D9E75"></span><span>Increases lifespan</span></div>
    <div class="legend-item"><span class="legend-dot" style="background:#D85A30"></span><span>Decreases lifespan</span></div>
    <div class="legend-item"><span class="legend-dot" style="background:#7F77DD"></span><span>Both effects</span></div>
    <div class="legend-item"><span class="legend-dot" style="background:#5F5E5A"></span><span>Effect unknown</span></div>
    <div class="legend-item"><span class="legend-size-hint"></span><span>Node size = confidence</span></div>
  `;
  document.getElementById('graph-wrap').appendChild(l);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', handleBuild);
panelClose.addEventListener('click', closeDetailPanel);
injectLegend();

init().catch(err => setErrorState(err.message));
