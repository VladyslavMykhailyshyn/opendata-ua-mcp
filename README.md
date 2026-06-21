# opendata-mcp — data.gov.ua MCP server

[Українською](./README-uk.md)

An open-source **MCP server** that lets **any MCP-compatible AI agent** search and analyze Ukraine's national open-data portal **[data.gov.ua](https://data.gov.ua)** in natural language.

It speaks the [Model Context Protocol](https://modelcontextprotocol.io), so it works with any client that supports MCP — including **Claude** (Desktop / Code), **ChatGPT** (Developer Mode / custom connectors), **Google Gemini**, **Cursor**, **Cline / Continue**, **VS Code Copilot**, local models via **Ollama / LM Studio**, and your own agents built on the Python/TypeScript MCP SDKs. Not tied to any single vendor.

**Phase 1: read-only, public endpoints — no API token, no auth required.**

## Design

Tools are **jobs-to-be-done**, not thin API wrappers. Each tool does a complete user task, composes several CKAN calls internally, hides portal quirks (UUID slugs, dirty formats, sparse DataStore, Unicode homoglyphs), and returns a **token-efficient slim result** (a search hit is ~150 B vs ~17 KB raw).

| Tool | What it does |
|---|---|
| `find_datasets` | Find datasets by topic; ranked slim candidates + refine hints |
| `explore_catalog` | Aggregate view (who publishes / how much) — counts only |
| `inspect_dataset` | Full dataset card: license, freshness, resources |
| `get_dataset_data` | Get the actual data — auto-picks best resource; DataStore or download+parse CSV/JSON/XLSX/XML, **including files inside ZIP archives** (ЄДР, debtors registries) |
| `filter_data` | Filter rows / read-only SQL over a structured (DataStore) resource |
| `track_updates` | Recently updated datasets, filterable by topic/org |

## Install

The server runs over **stdio**, the transport every MCP client understands. The config below is the same everywhere — only the file/menu where you paste it differs per client.

### Any MCP client (npm) — universal

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

Where to put it:

| Client | Location |
|---|---|
| **Claude Desktop** | Settings → Developer → Edit Config (`claude_desktop_config.json`) |
| **Claude Code** | `claude mcp add opendata-ua -- npx -y @opendata-ua/mcp-server` |
| **ChatGPT** | Settings → Connectors → add MCP server (Developer Mode) |
| **Google Gemini** | Gemini CLI / SDK `mcpServers` config |
| **Cursor** | Settings → MCP → Add Server (`~/.cursor/mcp.json`) |
| **Cline / Continue / VS Code** | the extension's MCP settings |
| **Custom agent** | point your MCP SDK at `npx -y @opendata-ua/mcp-server` |

### Claude Desktop — one-click DXT

DXT is Claude Desktop's drag-and-drop bundle format:

1. Download `opendata-ua-mcp.dxt` from [Releases](https://github.com/VladyslavMykhailyshyn/opendata-ua-mcp/releases).
2. Drag it into Claude Desktop → Settings → Extensions. Done. No config.

### From source

```bash
npm install
npm run build
node dist/stdio.js   # any MCP client can spawn this
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
