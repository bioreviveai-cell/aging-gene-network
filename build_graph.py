"""
build_graph.py — turns genes.json into a fully-solved, PRUNED graph.json

All heavy computation happens here, once, so the browser does zero graph math.
Key latency fix: we prune the edge list. A shared-hallmark graph is nearly
complete (every gene in a hallmark links to every other), which explodes to
tens of thousands of edges. We keep only edges where genes share >=2 hallmarks,
OR the top-K strongest edges per node. This keeps the graph readable AND fast.
"""
import json, math
import networkx as nx
from collections import defaultdict

OUT = '/mnt/user-data/outputs/aging-gene-network/'
genes = json.load(open(OUT + 'genes.json', encoding='utf-8'))
net_genes = [g for g in genes if g['agingMechanisms']]
print(f"Network-eligible genes: {len(net_genes)}")

# Full graph first (for accurate centrality), then prune for rendering
G_full = nx.Graph()
gene_hallmarks = {}
for g in net_genes:
    hids = {m['id'] for m in g['agingMechanisms']}
    gene_hallmarks[g['symbol']] = hids
    G_full.add_node(g['symbol'])

hallmark_to_genes = defaultdict(list)
for sym, hids in gene_hallmarks.items():
    for h in hids:
        hallmark_to_genes[h].append(sym)

pair_shared = defaultdict(int)
for h, syms in hallmark_to_genes.items():
    for i in range(len(syms)):
        for j in range(i+1, len(syms)):
            pair_shared[tuple(sorted((syms[i], syms[j])))] += 1

for (a, b), w in pair_shared.items():
    G_full.add_edge(a, b, weight=w)
print(f"Full graph: {G_full.number_of_nodes()} nodes, {G_full.number_of_edges()} edges")

# ─── Centrality on the FULL graph (accurate) ──────────────────────────────────
print("Computing centrality on full graph...")
deg = dict(G_full.degree())
btw = nx.betweenness_centrality(G_full, weight='weight', normalized=True)

bridge = {}
for sym in G_full.nodes():
    own = gene_hallmarks[sym]
    reach = set(own)
    for nb in G_full.neighbors(sym):
        reach |= gene_hallmarks[nb]
    bridge[sym] = btw[sym] * len(reach)
mx = max(bridge.values()) or 1
bridge = {k: v/mx for k, v in bridge.items()}

# ─── PRUNE edges for rendering ────────────────────────────────────────────────
# Strategy: keep edges with weight>=2 (share 2+ hallmarks = meaningful),
# plus guarantee every node keeps its single strongest edge so none float away.
MIN_WEIGHT = 2
TOP_PER_NODE = 6

kept = set()
# 1. strong edges
for (a, b), w in pair_shared.items():
    if w >= MIN_WEIGHT:
        kept.add((a, b))

# 2. ensure connectivity: each node keeps its top edges by weight
node_edges = defaultdict(list)
for (a, b), w in pair_shared.items():
    node_edges[a].append((w, a, b))
    node_edges[b].append((w, a, b))
for sym, lst in node_edges.items():
    for w, a, b in sorted(lst, reverse=True)[:TOP_PER_NODE]:
        kept.add((a, b))

edges = [{'s': a, 't': b, 'w': pair_shared[(a, b)]} for (a, b) in kept]
print(f"Pruned edges: {len(edges)} (from {len(pair_shared)})")

# Build pruned graph for layout
G = nx.Graph()
G.add_nodes_from(G_full.nodes())
for e in edges:
    G.add_edge(e['s'], e['t'], weight=e['w'])

# ─── Layout on pruned graph ───────────────────────────────────────────────────
print("Solving layout...")
pos = nx.spring_layout(G, k=2/math.sqrt(G.number_of_nodes()),
                       iterations=100, weight='weight', seed=42)
xs = [p[0] for p in pos.values()]; ys = [p[1] for p in pos.values()]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
def sc(v, lo, hi): return round((v-lo)/(hi-lo)*1000, 1) if hi > lo else 500

gene_by_sym = {g['symbol']: g for g in net_genes}
nodes = []
for sym in G.nodes():
    g = gene_by_sym[sym]
    nodes.append({
        'id': sym, 'x': sc(pos[sym][0], minx, maxx), 'y': sc(pos[sym][1], miny, maxy),
        'name': g['name'], 'lifespan': g['lifespan'],
        'conf': g['confidence_level'], 'conf_name': g['confidence_name'],
        'hallmarks': [m['name'] for m in g['agingMechanisms']],
        'diseases': g['diseases'], 'clusters': g['functionalClusters'],
        'ncbi_id': g['ncbi_id'], 'uniprot': g['uniprot'], 'ensembl': g['ensembl'],
        'degree': deg[sym], 'betweenness': round(btw[sym], 4), 'bridge': round(bridge[sym], 4),
    })

graph = {'nodes': nodes, 'edges': edges}
with open(OUT + 'graph.json', 'w', encoding='utf-8') as f:
    json.dump(graph, f, ensure_ascii=False, separators=(',', ':'))
print(f"Wrote graph.json ({len(open(OUT+'graph.json','rb').read())/1024:.0f} KB)")

top = sorted(nodes, key=lambda n: n['bridge'], reverse=True)[:25]
hubs = [{'id':n['id'],'name':n['name'],'bridge':n['bridge'],'betweenness':n['betweenness'],
         'degree':n['degree'],'n_hallmarks':len(n['hallmarks']),'hallmarks':n['hallmarks'],
         'lifespan':n['lifespan'],'conf_name':n['conf_name']} for n in top]
with open(OUT + 'hubs.json', 'w', encoding='utf-8') as f:
    json.dump(hubs, f, ensure_ascii=False, indent=2)
print(f"Wrote hubs.json (top {len(hubs)})")

print("\nTop 12 bridge genes:")
for n in top[:12]:
    print(f"  {n['id']:10s} bridge={n['bridge']:.3f} deg={n['degree']:4d} hallmarks={len(n['hallmarks'])}")
