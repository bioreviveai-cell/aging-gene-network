/**
 * Aging Gene Network — app.js
 *
 * HOW IT WORKS (learning guide):
 *
 * 1. FETCH  → We call the Open Genes REST API (no key needed).
 *             Endpoint: https://open-genes.com/api/gene/search
 *             Returns a JSON list of gene objects with names, hallmarks,
 *             confidence criteria counts, lifespan effects, etc.
 *
 * 2. FILTER → We apply the user's filter choices (hallmark, criteria, effect)
 *             locally in JS after fetching — this is faster than multiple API calls.
 *
 * 3. EDGES  → Genes that share the same hallmark (aging mechanism) get an edge
 *             between them. This is the simplest meaningful "connection" we can
 *             derive without a separate PPI database. If you later add STRING API
 *             calls, those edges can be layered on top.
 *
 * 4. RENDER → vis-network draws the graph. Node size = confidence (criteria count).
 *             Node color = lifespan effect (teal = increases, coral = decreases, gray = unknown).
 *             Edge thickness = number of shared hallmarks.
 *
 * 5. DETAIL → Clicking a node opens a side panel with full gene info.
 */

// ─── API config ────────────────────────────────────────────────────────────
const API_BASE = 'https://open-genes.com/api';

// ─── State ──────────────────────────────────────────────────────────────────
let network = null;      // vis-network instance
let allGenes = [];       // raw API response
let nodesDataset = null; // vis DataSet for nodes
let edgesDataset = null; // vis DataSet for edges

// ─── DOM refs ────────────────────────────────────────────────────────────────
const fetchBtn       = document.getElementById('fetch-btn');
const hallmarkSel    = document.getElementById('hallmark-select');
const criteriaSel    = document.getElementById('criteria-select');
const effectSel      = document.getElementById('effect-select');
const limitSel       = document.getElementById('limit-select');
const networkDiv     = document.getElementById('network');
const graphState     = document.getElementById('graph-state');
const stateMsg       = document.getElementById('state-message');
const stateSub       = document.getElementById('state-sub');
const detailPanel    = document.getElementById('detail-panel');
const panelContent   = document.getElementById('panel-content');
const panelClose     = document.getElementById('panel-close');
const statsBar       = document.getElementById('stats-bar');
const statNodes      = document.getElementById('stat-nodes');
const statEdges      = document.getElementById('stat-edges');
const statTopHub     = document.getElementById('stat-top-hub');
const geneBadge      = document.getElementById('gene-count-badge');

// ─── Colour palette ──────────────────────────────────────────────────────────
// These map to the three lifespan effect states in Open Genes
const COLORS = {
  increases: { bg: '#1D9E75', border: '#0F6E56', text: '#E1F5EE' }, // teal
  decreases: { bg: '#D85A30', border: '#993C1D', text: '#FAECE7' }, // coral
  unknown:   { bg: '#888780', border: '#5F5E5A', text: '#F1EFE8' }, // gray
};

// ─── Hallmark label map ───────────────────────────────────────────────────────
// Open Genes returns hallmark slugs; we give them readable names
const HALLMARK_LABELS = {
  'genome_instability':          'Genome instability',
  'telomere_attrition':          'Telomere attrition',
  'epigenetic_alterations':      'Epigenetic alterations',
  'loss_of_proteostasis':        'Loss of proteostasis',
  'deregulated_nutrient_sensing':'Deregulated nutrient sensing',
  'mitochondrial_dysfunction':   'Mitochondrial dysfunction',
  'cellular_senescence':         'Cellular senescence',
  'stem_cell_exhaustion':        'Stem cell exhaustion',
  'altered_intercellular':       'Altered intercellular communication',
  'disabled_macroautophagy':     'Disabled macroautophagy',
  'chronic_inflammation':        'Chronic inflammation',
  'dysbiosis':                   'Dysbiosis',
};

// ─── 1. BOOTSTRAP: populate hallmark dropdown from API ───────────────────────
async function loadHallmarks() {
  try {
    // The /aging_mechanism endpoint lists all hallmarks
    const res = await fetch(`${API_BASE}/aging_mechanism`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();

    // data is typically an array of objects like { id, name, slug }
    const items = Array.isArray(data) ? data : (data.items || data.data || []);
    items.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h.id || h.slug || h.name;
      opt.textContent = h.name || HALLMARK_LABELS[h.slug] || h.slug;
      hallmarkSel.appendChild(opt);
    });
  } catch (e) {
    // If this endpoint fails we still work — user just won't get hallmark options
    console.warn('Could not load hallmarks:', e.message);
    // Add known hallmarks manually as fallback
    Object.entries(HALLMARK_LABELS).forEach(([slug, label]) => {
      const opt = document.createElement('option');
      opt.value = slug;
      opt.textContent = label;
      hallmarkSel.appendChild(opt);
    });
  }
}

// ─── 2. FETCH genes from Open Genes API ──────────────────────────────────────
async function fetchGenes() {
  setLoadingState('Fetching genes from Open Genes API…', '');

  /*
   * TEACHING NOTE — the /gene/search endpoint:
   * GET https://open-genes.com/api/gene/search
   *   ?pageSize=N   — number of genes to return (max ~2400)
   *   &page=1       — pagination
   *   &lang=en      — English labels
   *
   * Each gene object includes:
   *   symbol            — standard gene symbol (e.g. FOXO3)
   *   name              — full gene name
   *   criteria          — number of selection criteria met (confidence proxy)
   *   agingMechanisms   — array of hallmark objects
   *   lifespanEffects   — array of effect objects
   *   diseases          — associated diseases
   *   functionalClusters — pathway groupings
   */
  const limit = parseInt(limitSel.value, 10);
  const url = `${API_BASE}/gene/search?pageSize=${limit}&page=1&lang=en`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();

  // The API may wrap results in .items or return an array directly
  return Array.isArray(data) ? data : (data.items || data.data || data.genes || []);
}

// ─── 3. FILTER genes locally ─────────────────────────────────────────────────
function filterGenes(genes) {
  /*
   * TEACHING NOTE:
   * We filter *after* fetching because the API's search params are limited.
   * Local filtering is instant for a few hundred genes.
   */
  const minCriteria  = parseInt(criteriaSel.value, 10);
  const effectFilter = effectSel.value;
  const hallmarkId   = hallmarkSel.value;

  return genes.filter(gene => {
    // Confidence: criteria is a number on the gene object
    const criteria = gene.criteria || gene.criteriaTotal || gene.ncbiId && 0 || 0;
    if (criteria < minCriteria) return false;

    // Lifespan effect filter
    if (effectFilter) {
      const effects = gene.lifespanEffects || gene.lifespan_effects || [];
      const hasEffect = effects.some(e => {
        const type = (e.type || e.effect || '').toLowerCase();
        return type.includes(effectFilter === 'increases' ? 'increas' : 'decreas');
      });
      if (!hasEffect) return false;
    }

    // Hallmark filter
    if (hallmarkId) {
      const mechs = gene.agingMechanisms || gene.aging_mechanisms || [];
      const hasMech = mechs.some(m =>
        String(m.id) === String(hallmarkId) ||
        m.slug === hallmarkId ||
        m.name === hallmarkId
      );
      if (!hasMech) return false;
    }

    return true;
  });
}

// ─── 4. BUILD NETWORK: nodes + edges ─────────────────────────────────────────
function buildNetwork(genes) {
  /*
   * TEACHING NOTE — edge logic:
   *
   * We connect two genes with an edge if they share at least one aging hallmark.
   * This is a "shared annotation" edge — not a physical protein interaction.
   * It tells you: "these genes both participate in the same aging mechanism."
   *
   * To add physical PPI edges you'd fetch STRING API for each gene symbol
   * and add those as a separate edge type with a different color.
   *
   * For large gene sets we cap edges per gene (MAX_EDGES_PER_NODE)
   * to keep the graph readable.
   */
  const MAX_EDGES_PER_NODE = 8;

  // Build a map: hallmark_id → [gene symbols]
  const hallmarkMap = {};
  genes.forEach(gene => {
    const mechs = gene.agingMechanisms || gene.aging_mechanisms || [];
    mechs.forEach(m => {
      const key = m.id || m.slug || m.name;
      if (!hallmarkMap[key]) hallmarkMap[key] = [];
      hallmarkMap[key].push(gene.symbol || gene.hgnc || gene.ncbiId);
    });
  });

  // Count how many shared hallmarks each gene pair has
  const pairCount = {};
  Object.values(hallmarkMap).forEach(symbols => {
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const key = [symbols[i], symbols[j]].sort().join('|||');
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  });

  // Track edge count per node to avoid spaghetti graphs
  const edgeCountPerNode = {};
  const edges = [];
  Object.entries(pairCount).forEach(([key, count]) => {
    const [a, b] = key.split('|||');
    const ca = edgeCountPerNode[a] || 0;
    const cb = edgeCountPerNode[b] || 0;
    if (ca >= MAX_EDGES_PER_NODE || cb >= MAX_EDGES_PER_NODE) return;
    edgeCountPerNode[a] = ca + 1;
    edgeCountPerNode[b] = cb + 1;
    edges.push({ from: a, to: b, value: count, sharedHallmarks: count });
  });

  // Build vis-network nodes
  const nodes = genes.map(gene => {
    const symbol    = gene.symbol || gene.hgnc || String(gene.ncbiId);
    const criteria  = gene.criteria || gene.criteriaTotal || 0;
    const effects   = gene.lifespanEffects || gene.lifespan_effects || [];
    const lifeEffect = getLifespanEffect(effects);
    const color     = COLORS[lifeEffect];

    return {
      id:       symbol,
      label:    symbol,
      title:    buildTooltip(gene),   // hover tooltip HTML
      value:    Math.max(criteria, 1), // node size
      color: {
        background: color.bg,
        border:     color.border,
        highlight:  { background: color.bg, border: '#1a1a1a' },
        hover:      { background: color.bg, border: '#1a1a1a' },
      },
      font:  { color: '#ffffff', size: 11, face: 'Inter, system-ui, sans-serif' },
      _raw:  gene,       // keep full gene data for detail panel
      _effect: lifeEffect,
    };
  });

  return { nodes, edges };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLifespanEffect(effects) {
  if (!effects || effects.length === 0) return 'unknown';
  for (const e of effects) {
    const t = (e.type || e.effect || '').toLowerCase();
    if (t.includes('increas')) return 'increases';
    if (t.includes('decreas')) return 'decreases';
  }
  return 'unknown';
}

function buildTooltip(gene) {
  const symbol = gene.symbol || gene.hgnc || '';
  const name   = gene.name || '';
  const crit   = gene.criteria || gene.criteriaTotal || 0;
  return `<div style="font-family:system-ui;font-size:12px;max-width:200px;padding:4px 6px">
    <strong>${symbol}</strong><br>
    <span style="color:#888">${name}</span><br>
    Criteria met: ${crit}
  </div>`;
}

// ─── 5. RENDER with vis-network ───────────────────────────────────────────────
function renderNetwork(nodes, edges) {
  /*
   * TEACHING NOTE — vis-network options:
   *
   * physics.barnesHut: a force-directed layout algorithm.
   *   - gravitationalConstant: negative = repulsion between nodes
   *   - springLength: preferred edge length in px
   *   - damping: how quickly motion settles (0–1)
   *
   * The stabilizationIterationsDone event fires when the layout settles —
   * we hide the loading state at that point.
   */
  if (network) {
    network.destroy();
    network = null;
  }

  const { DataSet, Network } = vis; // from vis-network CDN global

  nodesDataset = new DataSet(nodes);
  edgesDataset = new DataSet(edges);

  const options = {
    nodes: {
      shape: 'dot',
      scaling: {
        min: 10,
        max: 36,
        label: { enabled: false },
      },
      borderWidth: 1.5,
    },
    edges: {
      scaling: { min: 0.5, max: 4 },
      color: { color: '#d0cfc8', highlight: '#888780', hover: '#5F5E5A' },
      smooth: { type: 'continuous' },
      width: 0.8,
    },
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -4000,
        centralGravity: 0.3,
        springLength: 120,
        springConstant: 0.04,
        damping: 0.09,
      },
      stabilization: { iterations: 300, updateInterval: 25 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      navigationButtons: false,
      zoomView: true,
    },
  };

  network = new vis.Network(
    networkDiv,
    { nodes: nodesDataset, edges: edgesDataset },
    options
  );

  // Show loading dots while physics stabilizes
  network.on('stabilizationProgress', (params) => {
    const pct = Math.round((params.iterations / params.total) * 100);
    stateMsg.textContent = `Stabilizing layout… ${pct}%`;
  });

  network.on('stabilizationIterationsDone', () => {
    graphState.style.display = 'none';
    updateStats(nodes, edges);
  });

  // Click → open detail panel
  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const nodeData = nodesDataset.get(nodeId);
      if (nodeData) openDetailPanel(nodeData);
    } else {
      closeDetailPanel();
    }
  });
}

// ─── 6. STATS ─────────────────────────────────────────────────────────────────
function updateStats(nodes, edges) {
  /*
   * TEACHING NOTE — degree centrality:
   * Degree = number of edges connected to a node.
   * The node with highest degree is the "hub" — most connected gene.
   * In aging biology, hub genes often regulate multiple hallmarks.
   */
  const degreeCounts = {};
  edges.forEach(e => {
    degreeCounts[e.from] = (degreeCounts[e.from] || 0) + 1;
    degreeCounts[e.to]   = (degreeCounts[e.to]   || 0) + 1;
  });

  let topHub = null;
  let topDeg = 0;
  Object.entries(degreeCounts).forEach(([sym, deg]) => {
    if (deg > topDeg) { topDeg = deg; topHub = sym; }
  });

  statNodes.textContent   = `${nodes.length} genes`;
  statEdges.textContent   = `${edges.length} connections`;
  statTopHub.textContent  = topHub
    ? `Top hub: ${topHub} (${topDeg} connections)`
    : 'No hubs found';

  statsBar.classList.remove('hidden');

  // Update header badge
  geneBadge.textContent = `${nodes.length} genes`;
  geneBadge.classList.remove('hidden');
}

// ─── 7. DETAIL PANEL ─────────────────────────────────────────────────────────
function openDetailPanel(nodeData) {
  const gene = nodeData._raw;
  if (!gene) return;

  const symbol  = gene.symbol || gene.hgnc || nodeData.id;
  const name    = gene.name || '';
  const crit    = gene.criteria || gene.criteriaTotal || 0;
  const mechs   = gene.agingMechanisms || gene.aging_mechanisms || [];
  const effects = gene.lifespanEffects || gene.lifespan_effects || [];
  const diseases= gene.diseases || [];
  const clusters= gene.functionalClusters || gene.functional_clusters || [];
  const lifeEffect = nodeData._effect;
  const effectLabel = { increases: '↑ Increases lifespan', decreases: '↓ Decreases lifespan', unknown: '— Effect unknown' };
  const effectClass = { increases: 'tag-green', decreases: 'tag-coral', unknown: 'tag-gray' };

  const mechHTML = mechs.map(m =>
    `<span class="tag tag-purple">${m.name || HALLMARK_LABELS[m.slug] || m.slug}</span>`
  ).join('');

  const diseaseHTML = diseases.slice(0, 6).map(d =>
    `<span class="tag tag-gray">${d.name || d}</span>`
  ).join('') || '<span class="dim">None listed</span>';

  const clusterHTML = clusters.slice(0, 4).map(c =>
    `<span class="tag tag-blue">${c.name || c}</span>`
  ).join('') || '<span class="dim">None listed</span>';

  const ncbiLink = gene.ncbiId
    ? `<a href="https://www.ncbi.nlm.nih.gov/gene/${gene.ncbiId}" target="_blank" rel="noopener">NCBI ↗</a>`
    : '';
  const openGenesLink = `<a href="https://open-genes.com/gene/${symbol}" target="_blank" rel="noopener">Open Genes ↗</a>`;
  const uniProtLink = gene.uniprot
    ? `<a href="https://www.uniprot.org/uniprot/${gene.uniprot}" target="_blank" rel="noopener">UniProt ↗</a>`
    : '';

  panelContent.innerHTML = `
    <div class="panel-header">
      <div class="panel-symbol">${symbol}</div>
      <div class="panel-name">${name}</div>
      <span class="tag ${effectClass[lifeEffect]}">${effectLabel[lifeEffect]}</span>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Confidence</div>
      <div class="criteria-bar">
        <div class="criteria-fill" style="width:${Math.min(crit / 12 * 100, 100)}%"></div>
      </div>
      <div class="criteria-text">${crit} of 12 criteria met</div>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Aging hallmarks</div>
      <div class="tags-row">${mechHTML || '<span class="dim">None listed</span>'}</div>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Functional clusters</div>
      <div class="tags-row">${clusterHTML}</div>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Associated diseases</div>
      <div class="tags-row">${diseaseHTML}</div>
    </div>

    <div class="panel-links">
      ${openGenesLink}
      ${ncbiLink}
      ${uniProtLink}
    </div>
  `;

  detailPanel.classList.remove('closed');
}

function closeDetailPanel() {
  detailPanel.classList.add('closed');
}

// ─── 8. LOADING / ERROR STATES ───────────────────────────────────────────────
function setLoadingState(msg, sub) {
  graphState.style.display = 'flex';
  stateMsg.innerHTML = msg;
  stateSub.textContent = sub;
  networkDiv.style.opacity = '0.3';
}

function setErrorState(msg) {
  graphState.style.display = 'flex';
  stateMsg.innerHTML = `<span style="color:#E24B4A">⚠ ${msg}</span>`;
  stateSub.textContent = 'Check your connection and try again';
  networkDiv.style.opacity = '1';
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Load network';
}

function clearState() {
  networkDiv.style.opacity = '1';
}

// ─── 9. MAIN HANDLER ─────────────────────────────────────────────────────────
async function handleFetch() {
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Loading…';
  statsBar.classList.add('hidden');
  closeDetailPanel();

  try {
    // Step 1: fetch
    const rawGenes = await fetchGenes();

    if (rawGenes.length === 0) {
      setErrorState('No genes returned by the API — try relaxing your filters.');
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Load network';
      return;
    }

    // Step 2: filter
    setLoadingState('Filtering genes…', '');
    const filtered = filterGenes(rawGenes);

    if (filtered.length === 0) {
      setErrorState('No genes match your current filters. Try reducing the minimum criteria.');
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Load network';
      return;
    }

    // Step 3: build
    setLoadingState(`Building network for ${filtered.length} genes…`, '');
    const { nodes, edges } = buildNetwork(filtered);

    // Step 4: render
    setLoadingState('Rendering…', '');
    renderNetwork(nodes, edges);

  } catch (err) {
    console.error(err);
    setErrorState(err.message || 'Failed to load data from Open Genes API.');
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Load network';
    return;
  }

  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Reload';
}

// ─── 10. LEGEND ──────────────────────────────────────────────────────────────
function injectLegend() {
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = `
    <div class="legend-item">
      <span class="legend-dot" style="background:#1D9E75"></span>
      <span>Increases lifespan</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background:#D85A30"></span>
      <span>Decreases lifespan</span>
    </div>
    <div class="legend-item">
      <span class="legend-dot" style="background:#888780"></span>
      <span>Unknown</span>
    </div>
    <div class="legend-item">
      <span class="legend-size-hint"></span>
      <span>Node size = criteria count</span>
    </div>
  `;
  document.getElementById('graph-wrap').appendChild(legend);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', handleFetch);
panelClose.addEventListener('click', closeDetailPanel);

loadHallmarks();  // populate dropdown
injectLegend();   // show color key
