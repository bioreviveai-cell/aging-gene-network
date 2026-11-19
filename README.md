# Aging Gene Network

A live, interactive network visualizer for human aging genes, powered by the [Open Genes API](https://open-genes.com/api/docs). No backend, no build step — pure HTML/JS.

## What it does

- Fetches aging gene data live from the Open Genes REST API (no API key needed)
- Filters genes by aging hallmark, confidence level, and lifespan effect
- Builds a shared-hallmark network: two genes are connected if they participate in the same aging mechanism
- Renders an interactive force-directed graph with vis-network.js
- Click any gene node to see its hallmarks, associated diseases, and functional clusters

## File structure

```
index.html   — layout and markup
app.js       — all data fetching, filtering, network building, and rendering logic
style.css    — dark-themed stylesheet
netlify.toml — Netlify deployment config
README.md    — this file
```

## Deploy to Netlify via GitHub (step by step)

### 1. Create a GitHub repository

1. Go to [github.com](https://github.com) and click **New repository**
2. Name it `aging-gene-network` (or anything you like)
3. Leave it public, no README (you have one already)
4. Click **Create repository**

### 2. Push these files

```bash
cd path/to/aging-gene-network   # the folder containing these files

git init
git add .
git commit -m "Initial commit — aging gene network"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/aging-gene-network.git
git push -u origin main
```

### 3. Connect to Netlify

1. Go to [app.netlify.com](https://app.netlify.com) and click **Add new site → Import an existing project**
2. Choose **GitHub** and authorize Netlify
3. Select your `aging-gene-network` repository
4. Build settings:
   - **Build command**: leave empty (no build needed)
   - **Publish directory**: `.` (the root)
5. Click **Deploy site**

Netlify will deploy in ~30 seconds and give you a URL like `https://aging-gene-network.netlify.app`.

Every time you push to `main`, Netlify auto-deploys.

## Using your SQL dump

Your downloaded Open Genes SQL dump contains the same data as the API but lets you:

1. Run queries locally without hitting the API
2. Add richer gene data (e.g. protein interaction tables) that the API may not expose
3. Speed up development (no network latency)

To use it, import the dump into a local PostgreSQL or MySQL instance:

```bash
# PostgreSQL example
psql -U postgres -c "CREATE DATABASE opengenes;"
psql -U postgres -d opengenes -f open_genes_dump.sql
```

Then query it to generate a static `genes.json` file and serve that alongside your HTML. In `app.js`, change the fetch URL from the API endpoint to `./genes.json`. This is also how you'd add STRING PPI edges — join your gene list against the STRING database locally and export the edges.

## How the edge logic works

Two genes get a network edge when they share an aging hallmark (e.g. both are involved in cellular senescence). The edge weight is the number of shared hallmarks.

This is a **co-annotation** network, not a protein-protein interaction network. It answers: "which genes participate in the same aging mechanism?" 

To add physical PPI edges, pass your gene symbols to the STRING API:
```
https://string-db.org/api/json/network?identifiers=FOXO3%0ASIRT1%0ATP53&species=9606
```

## Filtering guide

| Filter | What it does |
|---|---|
| Aging hallmark | Shows only genes annotated with that specific aging mechanism |
| Min. criteria met | The number of experimental/evidence criteria the gene satisfies (1–12). Higher = more confidence |
| Lifespan effect | Filter for genes where intervention increases or decreases lifespan |
| Show top N | Limits the fetch to N genes (sorted by API default) |
