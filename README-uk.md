# opendata-mcp — MCP-сервер для data.gov.ua

[In English](./README.md)

Open-source **MCP-сервер**, що дозволяє **будь-якому AI-агенту з підтримкою MCP** шукати й аналізувати національний портал відкритих даних України **[data.gov.ua](https://data.gov.ua)** природною мовою.

Працює за [Model Context Protocol](https://modelcontextprotocol.io) — тож сумісний з будь-яким MCP-клієнтом: **Claude** (Desktop / Code), **ChatGPT** (Developer Mode / конектори), **Google Gemini**, **Cursor**, **Cline / Continue**, **VS Code Copilot**, локальні моделі через **Ollama / LM Studio**, а також ваші власні агенти на Python/TypeScript MCP SDK. Не прив'язаний до жодного вендора.

**Phase 1: лише читання, публічні endpoint'и — без API-токена й автентифікації.**

## Підхід

Інструменти — це **задачі користувача**, а не тонкі обгортки над API. Кожен інструмент виконує цілу задачу, всередині комбінує кілька CKAN-викликів, ховає особливості порталу (UUID-slug'и, брудні формати, майже порожній DataStore, юнікодні омогліфи) і повертає **компактний результат** (один результат пошуку ≈ 150 Б замість ≈ 17 КБ сирих даних).

| Інструмент | Що робить |
|---|---|
| `find_datasets` | Знайти датасети за темою; ранжований список + підказки звуження |
| `explore_catalog` | Агрегати (хто публікує / скільки) — лише лічильники |
| `inspect_dataset` | Картка датасету: ліцензія, свіжість, ресурси |
| `get_dataset_data` | Отримати самі дані — авто-вибір ресурсу; DataStore або завантаження+парсинг CSV/JSON/XLSX/XML, **зокрема файлів усередині ZIP-архівів** (ЄДР, реєстр боржників) |
| `filter_data` | Фільтр рядків / read-only SQL над структурованим ресурсом |
| `track_updates` | Нещодавно оновлені датасети, з фільтром за темою/розпорядником |

## Встановлення

Сервер працює через **stdio** — транспорт, який розуміє кожен MCP-клієнт. Конфіг скрізь однаковий, відрізняється лише місце, куди його вставити.

### Будь-який MCP-клієнт (npm) — універсально

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

Куди вставляти:

| Клієнт | Розташування |
|---|---|
| **Claude Desktop** | Settings → Developer → Edit Config (`claude_desktop_config.json`) |
| **Claude Code** | `claude mcp add opendata-ua -- npx -y @opendata-ua/mcp-server` |
| **ChatGPT** | Settings → Connectors → додати MCP-сервер (Developer Mode) |
| **Google Gemini** | конфіг `mcpServers` у Gemini CLI / SDK |
| **Cursor** | Settings → MCP → Add Server (`~/.cursor/mcp.json`) |
| **Cline / Continue / VS Code** | MCP-налаштування відповідного розширення |
| **Власний агент** | вкажіть MCP SDK на `npx -y @opendata-ua/mcp-server` |

### Claude Desktop — DXT в один клік

DXT — формат drag-and-drop пакетів Claude Desktop:

1. Завантажте `opendata-ua-mcp.dxt` зі сторінки [Releases](https://github.com/VladyslavMykhailyshyn/opendata-ua-mcp/releases).
2. Перетягніть у Claude Desktop → Settings → Extensions. Готово. Без налаштувань.

### З коду

```bash
npm install
npm run build
node dist/stdio.js   # будь-який MCP-клієнт може його запустити
```

## Приклади

> «Знайди датасети про екологію зі Львова за 2024 рік»
> «Які розпорядники публікують найбільше даних про закупівлі?»
> «Покажи перші рядки реєстру викрадених авто»

## Технічна довідка

Портал працює на **CKAN 2.7.2**. DataStore (запитувані рядки) покриває лише ~0.3 % ресурсів, тому `get_dataset_data` за потреби завантажує й парсить файли локально; `filter_data`/SQL працюють для DataStore-активної меншості.

## Ліцензія

MIT © Open Data UA Community
