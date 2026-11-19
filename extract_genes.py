"""
extract_genes.py  —  Open Genes SQL dump → genes.json + meta.json
"""

import re, json
from collections import defaultdict

SQL_PATH = '/mnt/user-data/uploads/open_genes.sql'
OUT_DIR  = '/mnt/user-data/outputs/aging-gene-network/'

# ─── Parser ───────────────────────────────────────────────────────────────────
def coerce(v):
    if v in ('NULL', ''): return None
    try: return int(v)
    except: pass
    try: return float(v)
    except: pass
    return v

def split_row(s):
    vals, cur, in_str, esc = [], [], False, False
    for c in s:
        if esc:              cur.append(c); esc = False
        elif c == '\\':     cur.append(c); esc = True
        elif c == "'" and not in_str: in_str = True
        elif c == "'" and in_str:     in_str = False
        elif c == ',' and not in_str: vals.append(coerce(''.join(cur).strip())); cur = []
        else:                cur.append(c)
    vals.append(coerce(''.join(cur).strip()))
    return vals

def parse_table(sql, table):
    rows = []
    pat = re.compile(rf"INSERT INTO `{re.escape(table)}` VALUES\s*(.*?);", re.DOTALL)
    for m in pat.finditer(sql):
        for rm in re.finditer(r'\(([^)]*(?:\([^)]*\)[^)]*)*)\)', m.group(1)):
            rows.append(split_row(rm.group(1)))
    return rows

print("Loading SQL dump …")
sql = open(SQL_PATH, encoding='utf-8', errors='replace').read()
print("  done.\n")

print("Parsing tables …")
gene_rows   = parse_table(sql, 'gene');              print(f"  gene:                            {len(gene_rows)}")
mech_rows   = parse_table(sql, 'aging_mechanism');   print(f"  aging_mechanism:                 {len(mech_rows)}")
amtgo_rows  = parse_table(sql, 'aging_mechanism_to_gene_ontology'); print(f"  aging_mechanism_to_gene_ontology:{len(amtgo_rows)}")
go_rows     = parse_table(sql, 'gene_ontology');     print(f"  gene_ontology:                   {len(go_rows)}")
gto_rows    = parse_table(sql, 'gene_to_ontology');  print(f"  gene_to_ontology:                {len(gto_rows)}")
conf_rows   = parse_table(sql, 'gene_to_confidence_level'); print(f"  gene_to_confidence_level:        {len(conf_rows)}")
clevel_rows = parse_table(sql, 'confidence_level');  print(f"  confidence_level:                {len(clevel_rows)}")
leff_rows   = parse_table(sql, 'gene_to_longevity_effect'); print(f"  gene_to_longevity_effect:        {len(leff_rows)}")
le_rows     = parse_table(sql, 'longevity_effect');  print(f"  longevity_effect:                {len(le_rows)}")
gtd_rows    = parse_table(sql, 'gene_to_disease');   print(f"  gene_to_disease:                 {len(gtd_rows)}")
disease_rows= parse_table(sql, 'disease');           print(f"  disease:                         {len(disease_rows)}")
gfc_rows    = parse_table(sql, 'gene_to_functional_cluster'); print(f"  gene_to_functional_cluster:      {len(gfc_rows)}")
fc_rows     = parse_table(sql, 'functional_cluster');print(f"  functional_cluster:              {len(fc_rows)}")

# ─── Lookup maps ──────────────────────────────────────────────────────────────
print("\nBuilding lookup maps …")

# aging_mechanism: id → name_en
mechanisms = {r[0]: r[2] for r in mech_rows if len(r) >= 3}

# confidence_level: id → name_en
conf_levels = {r[0]: r[2] for r in clevel_rows if len(r) >= 3}

# longevity_effect: id → name_en
longevity_effects = {r[0]: r[2] for r in le_rows if len(r) >= 3}

# disease: id → name_en  (col 3 is name_en based on sample)
diseases_map = {r[0]: r[3] for r in disease_rows if len(r) >= 4}

# functional_cluster: id → name_en
func_clusters = {r[0]: r[1] for r in fc_rows if len(r) >= 2}

# gene_ontology: id → {go_id, category, name_en}
go_terms = {}
for r in go_rows:
    if len(r) >= 4:
        go_terms[r[0]] = {'go_id': r[1], 'category': r[2], 'name': r[3]}

# aging_mechanism_to_gene_ontology: go_id → list of mechanism_ids
# TEACHING: This is the bridge. GO term → Aging hallmark.
go_to_mechanisms = defaultdict(list)
for r in amtgo_rows:
    if len(r) >= 3:
        go_id_key, mech_id = r[1], r[2]  # (id, gene_ontology_id, aging_mechanism_id)
        go_to_mechanisms[go_id_key].append(mech_id)

# gene_to_ontology: gene_id → list of go_ids
gene_to_go = defaultdict(set)
for r in gto_rows:
    if len(r) >= 3:
        gene_id, go_id_key = r[1], r[2]
        gene_to_go[gene_id].add(go_id_key)

# Derive gene → mechanisms (via GO terms)
gene_mechanisms = defaultdict(dict)  # gene_id → {mech_id: name}
for gene_id, go_ids in gene_to_go.items():
    for go_id_key in go_ids:
        for mech_id in go_to_mechanisms.get(go_id_key, []):
            if mech_id in mechanisms:
                gene_mechanisms[gene_id][mech_id] = mechanisms[mech_id]

print(f"  Genes with ≥1 hallmark: {sum(1 for v in gene_mechanisms.values() if v)}")

# gene → criteria count (number of confidence level entries = criteria met)
gene_confidence = defaultdict(int)
for r in conf_rows:
    if len(r) >= 3:
        gene_confidence[r[1]] += 1

# gene → lifespan direction
POSITIVE = {1, 6, 8, 10, 11, 12, 13, 14, 15}
NEGATIVE = {2, 9}
gene_effects = defaultdict(set)
for r in leff_rows:
    if len(r) >= 3 and r[2]:
        gene_effects[r[1]].add(r[2])

def lifespan_dir(eids):
    p = any(e in POSITIVE for e in eids)
    n = any(e in NEGATIVE for e in eids)
    if p and n: return 'both'
    if p: return 'increases'
    if n: return 'decreases'
    return 'unknown'

# gene → diseases
gene_diseases = defaultdict(list)
for r in gtd_rows:
    if len(r) >= 3:
        name = diseases_map.get(r[2])
        if name and name not in gene_diseases[r[1]]:
            gene_diseases[r[1]].append(name)

# gene → functional clusters
gene_clusters = defaultdict(list)
for r in gfc_rows:
    if len(r) >= 3:
        name = func_clusters.get(r[2])
        if name and name not in gene_clusters[r[1]]:
            gene_clusters[r[1]].append(name)

# ─── Assemble output ──────────────────────────────────────────────────────────
print("\nAssembling genes …")
HUMAN_TAXON = 6
out = []
for r in gene_rows:
    if len(r) < 20: continue
    gid, sym, aliases, name = r[0], r[1], r[2], r[3]
    ncbi_id, uniprot = r[4], r[5]
    is_hidden = r[19]
    taxon_id  = r[26] if len(r) > 26 else None
    ensembl   = r[27] if len(r) > 27 else None

    if is_hidden: continue
    if taxon_id is not None and taxon_id != HUMAN_TAXON: continue
    if not sym: continue

    eids = gene_effects.get(gid, set())
    mechs = [{'id': mid, 'name': mname}
             for mid, mname in gene_mechanisms.get(gid, {}).items()]

    out.append({
        'id':               gid,
        'symbol':           sym,
        'aliases':          aliases,
        'name':             name,
        'ncbi_id':          ncbi_id,
        'uniprot':          uniprot,
        'ensembl':          ensembl,
        'criteria':         gene_confidence.get(gid, 0),
        'lifespan':         lifespan_dir(eids),
        'lifespanEffects':  [longevity_effects[e] for e in eids if e in longevity_effects],
        'agingMechanisms':  mechs,
        'diseases':         gene_diseases.get(gid, [])[:8],
        'functionalClusters': gene_clusters.get(gid, [])[:6],
    })

out.sort(key=lambda g: g['criteria'], reverse=True)
print(f"  Output genes: {len(out)}")
print(f"  With hallmarks: {sum(1 for g in out if g['agingMechanisms'])}")
print(f"  With lifespan data: {sum(1 for g in out if g['lifespan'] != 'unknown')}")
print(f"  With diseases: {sum(1 for g in out if g['diseases'])}")

# ─── Write files ──────────────────────────────────────────────────────────────
genes_path = OUT_DIR + 'genes.json'
with open(genes_path, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
kb = len(open(genes_path).read().encode()) / 1024
print(f"\nWrote {genes_path}  ({kb:.0f} KB)")

meta = {
    'hallmarks': [{'id': mid, 'name': mn} for mid, mn in sorted(mechanisms.items(), key=lambda x: x[1])],
    'confidence_levels': [{'id': cid, 'name': cn} for cid, cn in sorted(conf_levels.items())],
}
meta_path = OUT_DIR + 'meta.json'
with open(meta_path, 'w', encoding='utf-8') as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
print(f"Wrote {meta_path}  ({len(meta['hallmarks'])} hallmarks)")

print("\nTop 5 genes by criteria:")
for g in out[:5]:
    mechs = ', '.join(m['name'] for m in g['agingMechanisms'][:2]) or '—'
    print(f"  {g['symbol']:12s}  crit={g['criteria']:2d}  life={g['lifespan']:10s}  {mechs}")
print("\nDone.")
