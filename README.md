# cds-kb-mcp

A **dataless** MCP server that gives AI agents instant, ranked access to **7,355 SAP S/4HANA released CDS views** via semantic search, business taxonomy, and on-demand definition retrieval.

> **TL;DR — fastest path:** install Node ≥ 18, point your MCP client at `node /path/to/cds-kb-mcp.mjs`, and you're done. No data download, no config. The server fetches what it needs from GitHub on first use, caches it, and revalidates in the background. See [Quick Start](#quick-start).
> 
> **Enterprise path:** Deploy the server to SAP BTP Cloud Foundry as an SSE endpoint, allowing your entire team to connect via a single `supergateway` config without running anything locally. See [Cloud Foundry Deployment](#cloud-foundry-deployment).

**Benchmark vs. raw file access:** ~830× faster, ~94× cheaper in tokens, better top-3 relevance — full numbers in [BENCHMARK.md](./BENCHMARK.md).

---

## Table of Contents

- [What you get](#what-you-get)
- [Quick Start](#quick-start) — under 60 seconds
- [Installation](#installation)
- [Running modes](#running-modes) — **online (recommended)** vs offline
- [Client Registration](#client-registration) — Claude Code, Claude Desktop, Antigravity, generic
- [Cloud Foundry Deployment (SSE)](#cloud-foundry-deployment) — run remotely, connect universally
- [Tools Reference](#tools-reference)
- [Configuration](#configuration) — env vars & flags
- [Network Resilience](#network-resilience)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [Development](#development)

---

## What you get

| | |
|---|---|
| **Coverage** | 7,355 released CDS views for S/4HANA Cloud Public Edition |
| **Enrichment** | 7,160 / 7,355 views have a semantic description + synonyms |
| **Taxonomy** | 12 Lines of Business → 829 Business Objects → keyword map |
| **Search ranking** | Field-boosted MiniSearch (`name×3`, `semanticDescription×2.5`, `synonyms×2`) |
| **Module aliasing** | Filter by `"Finance"` / `"Procurement"` / `"Sales"` instead of `FI` / `MM` / `SD` |
| **Tools** | 5 MCP tools: `search_cds`, `get_cds_view`, `get_views_by_tag`, `get_taxonomy`, `kb_info` |
| **Bundle** | Single 784 KB `.mjs` file, Node ≥ 18, zero runtime deps to install |
| **Data isolation** | The server ships **no view data**. Data lives in a separate repo, served over GitHub or via a local clone. |

---

## Quick Start

The recommended path is **online mode** — no clone of the data repo, no config, no path to set. The MCP fetches the search index on first start (~800 KB on the wire), caches it for 24 h, and then operates locally.

### 1. Install

```bash
git clone https://github.com/truongdva2/cds-kb-mcp.git
cd cds-kb-mcp
# The pre-built bundle is committed at dist/cds-kb-mcp.mjs — no build step needed.
```

### 2. Smoke test

```bash
node dist/cds-kb-mcp.mjs --help 2>&1 || true   # the server exits without input; that's expected
```

Stderr should read something like:

```
[cds-kb-mcp] ready. remote:https://raw.githubusercontent.com/truongdva2/cds-kb-data/main (cache ~/.cache/cds-kb/<hash>) | views=7355 enriched=7160 modules=31
```

### 3. Register with your MCP client

See [Client Registration](#client-registration) below. The shortest version, for Claude Code:

```bash
claude mcp add cds-kb -- node /absolute/path/to/cds-kb-mcp/dist/cds-kb-mcp.mjs
```

Then in any project ask the agent something like _"find me CDS views for vendor open items"_ and watch the tool fire.

---

## Installation

### Option A — pre-built bundle (recommended)

`dist/cds-kb-mcp.mjs` is committed to the repo. Clone it, that's it. No `npm install`, no build step.

```bash
git clone https://github.com/truongdva2/cds-kb-mcp.git
node cds-kb-mcp/dist/cds-kb-mcp.mjs    # ready to use
```

### Option B — build from source

```bash
git clone https://github.com/truongdva2/cds-kb-mcp.git
cd cds-kb-mcp
npm install
npm run build     # → dist/cds-kb-mcp.mjs (~784 KB)
```

### Option C — npm (when published)

```bash
npm install -g cds-kb-mcp
cds-kb-mcp        # binary on PATH
```

### Prerequisites

- **Node.js ≥ 18** — uses native `fetch`, ES modules, `AbortController`.
- No external services to provision.
- No SAP system access needed — the KB describes the *released* CDS views, not your tenant data.

---

## Running modes

The MCP supports two data-source modes. **Use online unless you have a specific reason not to.**

### 🟢 Online mode (default, recommended)

```bash
node dist/cds-kb-mcp.mjs
```

The server lazily fetches the search index + views from the upstream GitHub data repo, caches everything under `~/.cache/cds-kb/<sha1-of-url>/`, and revalidates against upstream via ETag. **No flags needed**.

Why this is the recommended default:

| | Online (default) | Offline (`--data`) |
|---|---|---|
| Setup | Zero — just run the bundle | Must clone `cds-kb-data` (≈ 80 MB unzipped) and pass its path |
| Data freshness | Auto-syncs with upstream on TTL expiry | Stays at whatever commit you cloned; manual `git pull` to update |
| Disk usage | 6 MB cache + on-demand views (~30 KB each) | Full 80 MB clone |
| Cold-start latency | ~3 s on first run; ~150 ms afterwards | ~100 ms always |
| Network requirement | First run + revalidations only | None |
| Custom Z-namespace views | Not supported | Fork the data repo |

The on-the-wire cost is much lower than the file sizes suggest — Node `fetch()` auto-negotiates gzip, so the 5.7 MB index transfers as ~820 KB.

Override the default URL (e.g. to point at your own fork):

```bash
node dist/cds-kb-mcp.mjs --remote https://raw.githubusercontent.com/<you>/cds-kb-data/main
```

Or via env:

```bash
CDS_KB_REMOTE=https://raw.githubusercontent.com/<you>/cds-kb-data/main \
  node dist/cds-kb-mcp.mjs
```

### 🟡 Offline mode (`--data`)

Use only when you have a clear reason:

- Air-gapped or strict-firewall environments
- You maintain a custom data repo with Z-namespace views and want sub-second cold-start
- CI runs where you've already checked out the data repo
- Reproducibility: pin to a specific data commit

```bash
git clone https://github.com/truongdva2/cds-kb-data.git
node dist/cds-kb-mcp.mjs --data ./cds-kb-data
```

Or via env:

```bash
CDS_KB_DATA=./cds-kb-data node dist/cds-kb-mcp.mjs
```

### Resolution order

CLI flags → environment variables → online default. Specifically:

| Priority | Source | Mode |
|--:|---|---|
| 1 | `--data <path>` | Offline |
| 2 | `CDS_KB_DATA` env | Offline |
| 3 | `--remote <url>` | Online (custom URL) |
| 4 | `CDS_KB_REMOTE` env | Online (custom URL) |
| 5 | *none* | **Online (upstream default) ← you land here normally** |

---

## Client Registration

### Claude Code

The fastest way:

```bash
claude mcp add cds-kb -- node /absolute/path/to/cds-kb-mcp/dist/cds-kb-mcp.mjs
```

Verify:

```bash
claude mcp list
```

You should see `cds-kb` in the list. Inside any project the model now has access to `mcp__cds-kb__search_cds`, `mcp__cds-kb__get_cds_view`, and the rest.

To scope to one project, add `--scope project`. To remove: `claude mcp remove cds-kb`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "cds-kb": {
      "command": "node",
      "args": ["/absolute/path/to/cds-kb-mcp/dist/cds-kb-mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop. The wrench icon should list five new tools under "cds-kb".

### Antigravity IDE

```json
{
  "mcpServers": {
    "cds-kb": {
      "command": "node",
      "args": ["/absolute/path/to/cds-kb-mcp/dist/cds-kb-mcp.mjs"]
    }
  }
}
```

### Cursor / generic MCP clients

The same JSON config works for any MCP-compatible client — point them at the bundle. The server speaks MCP over stdio.

### Optional: offline-mode config

If you've cloned the data repo and want the client to launch in offline mode, add the `--data` flag:

```json
{
  "mcpServers": {
    "cds-kb": {
      "command": "node",
      "args": [
        "/absolute/path/to/cds-kb-mcp/dist/cds-kb-mcp.mjs",
        "--data",
        "/absolute/path/to/cds-kb-data"
      ]
    }
  }
}
```

---

## Tools Reference

The server exposes **five tools**. They are designed so an AI agent can go from a vague business question to a complete CDS view definition in two or three calls.

### 1. `search_cds`

Find CDS views by business meaning, name, tag, or classic SAP keyword (`VBAK`, `BSEG`, etc.). Returns a ranked shortlist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Natural language or keyword (e.g. `"overdue customer invoices"`) |
| `module` | string | optional | Module filter — code (`FI`, `SD`, `MM`) or natural name (`"Finance"`, `"Procurement"`) |
| `lob` | string | optional | Line-of-business filter (partial match) |
| `bo` | string | optional | Business object filter (partial match, e.g. `"salesorder"`) |
| `limit` | int 1-50 | optional | Max results (default 10) |

Returns: ranked list with `name`, `score`, `module`, short description, and path.

```text
1. **I_CAOPENITEMLIST**  [FI-FIO-AR-2CL]  (score 14.2)
   List of open items across customer and vendor accounts.
   path: views/I_CAOPENITEMLIST.md
2. **I_PARKEDOPLACCTGDOCRBLSITEM**  ...
```

### 2. `get_cds_view`

Fetch one view's definition by exact name. Default: full markdown (metadata + fields + associations + source). Use `sections` to slim down the response.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Exact view name (case-insensitive), e.g. `I_SalesDocument` |
| `sections` | string[] | optional | Subset of `["metadata", "fields", "associations", "source"]`. Default: all. |

Typical pattern: `search_cds` → pick a hit → `get_cds_view(name, sections=["metadata", "fields"])` to confirm the field list without pulling 5-10 KB of DDL source.

### 3. `get_views_by_tag`

Deterministic listing by tag. Use when `search_cds` is too fuzzy.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `tag` | string | ✓ | Exact tag, e.g. `"bo:salesorder"`, `"lob:finance"` |
| `limit` | int 1-200 | optional | Default 50 |

Discover valid tags with `get_taxonomy` first.

### 4. `get_taxonomy`

Returns the semantic map: 12 Lines of Business → 829 Business Objects, each with keywords and synonyms. Useful for the agent to orient itself before issuing a search, or to discover valid tags for `get_views_by_tag`.

No parameters.

### 5. `kb_info`

Report the active data source, view count, enrichment coverage, and index build timestamp. Use this to verify which version of the KB you're talking to.

```text
source: remote:https://raw.githubusercontent.com/truongdva2/cds-kb-data/main (cache ~/.cache/cds-kb/...)
views: 7355
enriched: 7160
modules: 31
builtAt: 2026-06-25T09:13:52.301Z
```

---

## Configuration

Everything is optional. The defaults are what you want unless you're operating offline or behind a strict proxy.

### CLI flags

| Flag | Value | Effect |
|---|---|---|
| `--data <path>` | absolute or relative path | Run in offline mode against a local data clone |
| `--remote <url>` | base URL | Run in online mode against a custom data URL |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CDS_KB_DATA` | — | Path to local data repo (alternative to `--data`) |
| `CDS_KB_REMOTE` | `https://raw.githubusercontent.com/truongdva2/cds-kb-data/main` | Base URL for online mode |
| `CDS_KB_REFRESH` | `0` | Set to `1` to bypass cache and force a fresh download |
| `CDS_KB_CACHE_TTL_HOURS` | `1` | Legacy TTL — only used when upstream lacks `version.json`. With the version manifest in place, this rarely fires |
| `CDS_KB_FETCH_TIMEOUT_MS` | `20000` | Per-request HTTP timeout (online mode) |
| `CDS_KB_FETCH_RETRIES` | `3` | Max attempts on network errors / 5xx / 408 / 429 |
| `XDG_CACHE_HOME` | `~/.cache` | Honoured for cache directory location |

### Cache location

Online mode stores everything under `${XDG_CACHE_HOME:-~/.cache}/cds-kb/<sha1-of-base-url>/`:

```text
~/.cache/cds-kb/59f498ee5cf8/
├── search_index.json    # 5.7 MB MiniSearch index
├── taxonomy.json        # 231 KB business taxonomy
├── version.json         # ~200 B — {commit, builtAt, viewCount, ...}; checked on every startup
├── etags.json           # ETag map for conditional GETs
└── views/
    ├── I_BUSINESSPARTNER.md
    └── ...              # fetched on demand
```

To wipe and re-fetch:

```bash
rm -rf ~/.cache/cds-kb/
# or
CDS_KB_REFRESH=1 node dist/cds-kb-mcp.mjs
```

---

## Network Resilience

The remote backend is designed to survive ordinary network conditions:

| Feature | Behaviour | Tunable |
|---|---|---|
| **Version manifest probe** | On every startup, fetch `index/version.json` (~200 B). If `commit` matches the cached one, the 5.7 MB index is reused regardless of TTL — guarantees fresh data in seconds after upstream rebuilds | Automatic |
| **Per-request timeout** | Each HTTP GET aborts after 20 s | `CDS_KB_FETCH_TIMEOUT_MS` |
| **Retry with exponential backoff** | Up to 3 attempts on network errors and 5xx/408/429 (500 ms → 1 s → 2 s) | `CDS_KB_FETCH_RETRIES` |
| **Conditional GET via ETag** | Subsequent requests send `If-None-Match`; on 304 just refresh mtime — no re-download | Automatic |
| **Atomic cache writes** | Writes via `*.tmp` + rename → `kill -9` mid-write cannot corrupt cache | Automatic |
| **JSON integrity check** | Index and taxonomy parsed before being persisted; corrupt downloads never overwrite a good cache | Automatic |
| **Stale-while-revalidate** | TTL-expired cache served immediately; refresh happens in background (legacy fallback when upstream lacks `version.json`) | Automatic |
| **Terminal 4xx fast-fail** | 404 / 403 fail on first attempt — no wasted retries on permanent errors | Automatic |

Net effect: when the data repo publishes a new commit, the **next** MCP session picks it up automatically — the startup probe sees the commit mismatch and refreshes. A brief GitHub outage can't break an active session; warm-cache restarts skip the 800 KB index re-download.

### How updates propagate

```
  cds-kb-data push  →  GitHub Action rebuilds index + stamps version.json  →  push back to main
                                                                                       │
                                  ▼ (no work needed by users)                          │
  Next MCP startup:  GET /index/version.json (~200B)                                   │
                     compare commit vs cached                                          │
                     mismatch → re-download index (800 KB on the wire)  ◀──────────────┘
                     match    → reuse cached index, regardless of TTL
```

End-to-end latency from a data push to clients seeing the new data: **the time of one MCP restart** — typically a few seconds the next time a client opens a new session.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                         AI Client (Claude)                       │
│              search_cds("vendor open items", "FI")               │
└──────────────────────────┬───────────────────────────────────────┘
                           │  MCP / JSON-RPC over stdio
┌──────────────────────────▼───────────────────────────────────────┐
│                   cds-kb-mcp (this server)                       │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐         │
│  │ search_cds│ │ get_view  │ │ taxonomy  │ │ kb_info   │  ...    │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘         │
│        └─────────────┴─────────────┴─────────────┘               │
│                       │                                          │
│  ┌────────────────────▼───────────────────┐                      │
│  │   MiniSearch (in-memory, 5.7 MB index) │                      │
│  └────────────────────┬───────────────────┘                      │
│                       │                                          │
│  ┌────────────────────▼───────────────────┐                      │
│  │   DataSource (Local | Remote)          │                      │
│  │   • ETag-validated cache               │                      │
│  │   • Atomic writes, SWR, retry          │                      │
│  └─────────┬───────────────────┬──────────┘                      │
└────────────┼───────────────────┼─────────────────────────────────┘
             │                   │
       ┌─────▼────┐         ┌────▼──────────────┐
       │ Local FS │         │ GitHub Raw / CDN  │
       │ cds-kb-  │         │ raw.github...     │
       │ data/    │         └───────────────────┘
       └──────────┘
```

### Key design decisions

1. **Dataless server.** The 80 MB data repo is *never* bundled — the server is just code (784 KB). Data updates ship independently as commits to [`cds-kb-data`](https://github.com/truongdva2/cds-kb-data).
2. **Self-describing index.** `search_index.json` carries its own MiniSearch options. The server has zero schema knowledge of how the index was built, so the data repo can evolve without breaking deployed servers.
3. **Online-first.** Cold-start cost is paid once per machine, then amortised across every session via ETag-validated cache. No clone step in the happy path.
4. **No AI-context bloat.** All 5.7 MB of index lives inside the MCP process. The model only ever sees ranked, short text responses — typically 80–400 tokens per call.
5. **Stdio transport.** The server speaks JSON-RPC over stdio. It runs anywhere Node ≥ 18 runs; no HTTP server, no port to expose, no auth to configure.

---

## Cloud Foundry Deployment

You can deploy `cds-kb-mcp` to SAP BTP Cloud Foundry to act as a centralized, remote server for multiple clients without them needing to clone the repository.

1. Add a `manifest.yml` to the root of the project:
   ```yaml
   ---
   applications:
     - name: cds-kb-mcp
       memory: 512M
       default-route: true
       buildpacks:
         - nodejs_buildpack
       command: npm start
       env:
         USE_SSE: "true"
         # API_KEY: "your-secret-key-here" # Uncomment to enable API Key authentication
   ```
2. Run `cf push` to deploy the server.
3. The server will automatically start listening on HTTP for SSE connections at `/sse`.

### Client Configuration (Universal Method)

For **any IDE** that supports MCP via standard command (Cursor, Claude Desktop, Gemini IDE), use the `supergateway` package to securely bridge the remote SSE server back into local stdio.

Add this block to your `mcpServers` configuration file (e.g., `claude_desktop_config.json` or `mcp_config.json`):

```json
{
  "mcpServers": {
    "cds-cloud": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://<YOUR_CF_APP_URL>/sse"
      ]
    }
  }
}
```

This ensures you have exactly **one configuration method** across all agents, without requiring users to manually create or host proxy scripts.

---

## Troubleshooting

### "Module not found" or fails to start

Check Node version:

```bash
node --version   # must be >= 18
```

Confirm the bundle exists:

```bash
ls -l dist/cds-kb-mcp.mjs
```

### Search returns poor results

Run `kb_info` and check the `enriched` count. If it's `0` or much lower than `viewCount`, the index was built without enrichment. The fix is on the data-repo side:

```bash
cd cds-kb-data
node enrich_index.mjs
```

If you're on online mode and seeing this, file an issue on `cds-kb-data` — the upstream index needs a rebuild.

### Cache feels stale

Two options:

```bash
# A) Force a one-time refresh
CDS_KB_REFRESH=1 node dist/cds-kb-mcp.mjs

# B) Wipe cache entirely
rm -rf ~/.cache/cds-kb/
```

Normal operation does not require either — the 24 h TTL + ETag revalidation handle drift automatically.

### Behind a corporate proxy / firewall

If `raw.githubusercontent.com` is blocked:

1. Switch to offline mode — clone the data repo behind the firewall and use `--data`.
2. Or set `HTTPS_PROXY` / `HTTP_PROXY` env vars; Node `fetch()` honours them via undici.

### View not found

The exact view name might differ. Always call `search_cds` first to get the canonical name, then `get_cds_view` with that name. Names are case-insensitive.

### "Failed to fetch view ...: data source may be temporarily unreachable"

This is a transient error message (added in v1.2 to distinguish from "view not found"). The server already retried 3× with backoff. Wait a few seconds and call again — the cache and SWR will usually paper over upstream blips.

---

## Project Structure

```text
cds-kb-mcp/
├── dist/
│   └── cds-kb-mcp.mjs        # Self-contained bundle — what you ship to users
├── src/
│   ├── server.mjs            # MCP server + 5 tool registrations
│   └── datasource.mjs        # Local + Remote backends, ETag, SWR, retry
├── build.mjs                 # esbuild config
├── enrich_index.mjs          # Helper script (run against cds-kb-data repo)
├── test_tools.mjs            # Smoke test against a live server
├── package.json
├── README.md                 # ← you are here
├── BENCHMARK.md              # Detailed performance & quality comparison
└── cds-kb-data/              # Git submodule pointer (optional clone)
```

---

## Development

### Run from source

```bash
npm install
node src/server.mjs           # online mode
node src/server.mjs --data ./cds-kb-data   # offline mode
```

### Rebuild the bundle

```bash
npm run build
```

This regenerates `dist/cds-kb-mcp.mjs` via esbuild. Commit the rebuilt file so end-users don't need a build step.

### Run smoke tests

```bash
# Against a local data clone
node test_tools.mjs ./cds-kb-data

# Against the default online source
node test_tools.mjs
```

The script exercises all five tools and prints sample output.

### Updating the search index

The MCP itself never builds the index — that happens in [`cds-kb-data`](https://github.com/truongdva2/cds-kb-data) via a GitHub Action that auto-triggers on every data change. Contributors edit `.md` view files or `index/taxonomy.json`, push, and the bot regenerates `search_index.json` + `version.json` on `main`.

> **Full contributor guide lives in the data repo:** see [`cds-kb-data/README.md`](https://github.com/truongdva2/cds-kb-data#updating-data--cicd-workflow) — pipeline diagram, the 5-step dev checklist, and 6 common-scenario fixes.

#### Short version (data side)

```
edit views/X.md  →  git push  →  Action rebuilds  →  bot commits index/* back to main
                                                                         │
                                                                         ▼
                                              Next MCP session sees commit
                                              mismatch via version.json probe
                                              → cache invalidated → fresh data
```

The workflow file is `cds-kb-data/.github/workflows/rebuild-on-push.yml`. It checks out `cds-kb-mcp@main` to get `enrich_index.mjs`, installs only `minisearch` (the script's one dep), and uses `$GITHUB_SHA` to stamp the version manifest. Concurrency-guarded: two quick pushes won't race.

#### Manual rebuild (rare — for iterating on `enrich_index.mjs` itself, or air-gapped use)

```bash
cd cds-kb-mcp
node enrich_index.mjs ../cds-kb-data
cd ../cds-kb-data
git add index/search_index.json index/version.json
git commit -m "data: <what changed>"
git push
```

If you change `enrich_index.mjs` in *this* repo, trigger the data-repo workflow manually afterwards so it rebuilds with your new logic: data-repo → Actions tab → "Rebuild search index on data change" → **Run workflow** button.

#### What clients see

On every MCP startup the server fetches `<base>/index/version.json` (~200 B, bypasses TTL). When the upstream `commit` differs from what was cached on the previous run, the cache is invalidated and the index is re-downloaded. Result: every new data push is visible to every client on their next session — usually within seconds. The server logs the transition explicitly:

```
[cds-kb-mcp] upstream commit a1b2c3d4 ≠ cached deadbeef — refreshing index
```

#### Client-side troubleshooting

| Symptom | Fix |
|---|---|
| `kb_info` shows an old `commit` | Restart the MCP host (Claude Code / Desktop). Cache probe only runs at startup. |
| Cache feels stuck | `rm -rf ~/.cache/cds-kb/` then restart |
| Need an immediate refresh in this session | `CDS_KB_REFRESH=1 node dist/cds-kb-mcp.mjs` |
| `kb_info` shows `commit: (no version manifest)` | The data source is an older snapshot without `version.json`. Either pull a fresh `cds-kb-data`, or wait for the next 1-hour TTL (legacy fallback). |

---

## License

MIT. See `LICENSE` if present, or the repo metadata.
