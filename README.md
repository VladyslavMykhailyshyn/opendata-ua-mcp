# opendata-mcp — data.gov.ua MCP server

[Українською](./README-uk.md)

An open-source **MCP server** that lets AI assistants (Claude Desktop, Claude Code, any MCP client) search and analyze Ukraine's national open-data portal **[data.gov.ua](https://data.gov.ua)** in natural language.

**Phase 1: read-only, public endpoints — no API token, no auth required.**

## Design

Tools are **jobs-to-be-done**, not thin API wrappers. Each tool does a complete user task, composes several CKAN calls internally, hides portal quirks (UUID slugs, dirty formats, sparse DataStore, Unicode homoglyphs), and returns a **token-efficient slim result** (a search hit is ~150 B vs ~17 KB raw).

| Tool | What it does |
|---|---|
| `find_datasets` | Find datasets by topic; ranked slim candidates + refine hints |
| `explore_catalog` | Aggregate view (who publishes / how much) — counts only |
| `inspect_dataset` | Full dataset card: license, freshness, resources |
| `get_dataset_data` | Get the actual data (auto-picks best resource; DataStore or download+parse) |
| `filter_data` | Filter rows / read-only SQL over a structured (DataStore) resource |
| `track_updates` | Recently updated datasets, filterable by topic/org |

## Install

### Claude Desktop (easiest) — DXT

1. Download `opendata-ua-mcp.dxt` from [Releases](https://github.com/opendata-ua/opendata-mcp/releases).
2. Drag-and-drop it into Claude Desktop → Settings → Extensions. Done. No config.

### npm

```bash
npx @opendata-ua/mcp-server
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "opendata-ua": {
      "command": "npx",
      "args": ["-y", "@opendata-ua/mcp-server"]
    }
  }
}
```

### From source

```bash
npm install
npm run build
node dist/stdio.js
```

## Try it

> "Find ecology datasets from Lviv published in 2024"
> "Which organizations publish the most procurement data?"
> "Show me the first rows of the stolen-vehicles register"

## Configuration (optional)

| Env var | Default | Purpose |
|---|---|---|
| `DATA_GOV_UA_BASE_URL` | `https://data.gov.ua/api/3/action` | API base (mirror/dev portal) |
| `CACHE_TTL_SECONDS` | `300` | LRU cache TTL for catalogs |
| `HTTP_TIMEOUT_MS` | `30000` | Request timeout |
| `MAX_RESPONSE_CHARS` | `60000` | Per-response context-budget ceiling |
| `MAX_DOWNLOAD_BYTES` | `10000000` | Cap for files downloaded + parsed locally |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

## Develop

```bash
npm test          # vitest
npm run typecheck
npm run lint
npm run smoke      # live test against data.gov.ua
npm run build:dxt  # build the .dxt package
```

The portal runs **CKAN 2.7.2**. DataStore (queryable rows) covers only ~0.3 % of resources, so `get_dataset_data` downloads + parses files locally when needed; `filter_data`/SQL apply to the DataStore-active minority.

## License

MIT © Open Data UA Community
