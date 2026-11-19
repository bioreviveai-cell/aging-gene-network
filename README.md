# Aging Gene Network

An interactive network of human aging genes, built from the Open Genes database.
Pure HTML/JS/canvas — no backend, no build step, no runtime API calls.

## Why it's fast

Every expensive computation happens **once, at build time** in Python:

- parsing the SQL dump
- building the shared-hallmark graph
- solving the layout (node x,y positions are baked into the data)
- computing degree + betweenness centrality
- deriving the bridge-gene scores
- pruning 41,672 raw edges down to ~3,100 meaningful ones

The browser just **paints precomputed positions on a `<canvas>`** in a single
draw call. There is no physics simulation and no O(n²) edge-building at runtime,
which is what made the earlier vis-network version slow.

## What's new: bridge genes

The right-hand panel ranks **bridge genes** — genes that connect the most
*distinct* aging hallmarks. The score is:

```
bridge = betweenness_centrality × (number of distinct hallmarks reachable)
```

A high bridge score means the gene sits between otherwise-separate aging
mechanisms. Biologically, these are candidates for influencing several
hallmarks at once — the kind of multi-target node worth a closer look.
Click any bridge gene to zoom straight to it in the graph.

The top result, PARK7 (DJ-1), is a well-known multi-hallmark aging gene
(oxidative stress, mitochondria, proteostasis), which is a good sign the
metric is picking up real biology.

## Files

```
index.html       — layout + canvas
app.js           — canvas renderer, filtering, bridge panel, interaction
style.css        — dark theme
graph.json       — precomputed nodes (with x,y + metrics) and pruned edges
hubs.json        — top 25 bridge genes
meta.json        — hallmark list for the filter
extract_genes.py — SQL dump → genes.json  (stage 1)
build_graph.py   — genes.json → graph.json + hubs.json  (stage 2)
netlify.toml     — deploy config
```

## Rebuilding the data

When Open Genes publishes a new SQL dump:

```bash
python3 extract_genes.py     # SQL dump  → genes.json + meta.json
python3 build_graph.py        # genes.json → graph.json + hubs.json
```

`build_graph.py` needs NetworkX: `pip install networkx`.

### Tuning the graph

In `build_graph.py`:
- `MIN_WEIGHT` (default 2) — keep edges where genes share at least this many hallmarks
- `TOP_PER_NODE` (default 6) — each node keeps its strongest N edges so nothing floats away

Lower `MIN_WEIGHT` for a denser graph, raise it for a sparser, faster one.

## Deploy to Netlify

```bash
cd aging-gene-network
git init
git add .
git commit -m "Aging gene network with bridge-gene analysis"
git branch -M main
git remote add origin https://github.com/YOU/aging-gene-network.git
git push -u origin main
```

Then in Netlify: **Add new site → Import an existing project → GitHub**, pick the
repo, leave the build command empty, publish directory `.`, deploy. Every push
auto-deploys.

## Controls

| Control | Effect |
|---|---|
| Aging hallmark | Show only genes in that mechanism |
| Confidence | Filter by Open Genes evidence level (highest → all) |
| Lifespan effect | Increases / decreases / both |
| Highlight | Size nodes by bridge score or by connection count |
| Scroll / drag / click | Zoom, pan, open a gene's detail card |

## Next ideas

- Add real protein-protein interaction edges from STRING (precompute them in a
  third Python stage so runtime stays instant)
- Color edges by *which* hallmark they come from
- Export the current filtered view as a `.graphml` for Cytoscape
