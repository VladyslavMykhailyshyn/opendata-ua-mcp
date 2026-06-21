# MCP-сервер для порталу відкритих даних України (`data.gov.ua`)

> Open-source MCP (Model Context Protocol) server, що надає LLM-агентам та користувачам Claude Desktop зручний інтерфейс до Українського національного порталу відкритих даних.

---

## Зміст

1. [Огляд та мета проєкту](#1-огляд-та-мета-проєкту)
2. [Поточний стан API `data.gov.ua`](#2-поточний-стан-api-datagovua)
3. [Виявлені обмеження та пропозиції покращень API](#3-виявлені-обмеження-та-пропозиції-покращень-api)
4. [Архітектура MCP-сервера](#4-архітектура-mcp-сервера)
5. [MCP Tools — повний перелік функцій](#5-mcp-tools--повний-перелік-функцій)
6. [MCP Resources та Prompts](#6-mcp-resources-та-prompts)
7. [Структура проєкту](#7-структура-проєкту)
8. [Roadmap (фази розробки)](#8-roadmap-фази-розробки)
9. [Тестування та верифікація](#9-тестування-та-верифікація)
10. [Ліцензія, community та поширення](#10-ліцензія-community-та-поширення)

---

## 1. Огляд та мета проєкту

**Проблема.** Український національний портал відкритих даних `data.gov.ua` містить десятки тисяч датасетів (реєстри, бюджетні дані, статистика, екологія, інфраструктура тощо), що публікуються розпорядниками за Законом «Про доступ до публічної інформації». Незважаючи на наявність CKAN Action API, для звичайного громадянина, журналіста чи аналітика витягнути потрібну інформацію залишається технічним викликом: треба знати назву endpoint, формат запиту, ID ресурсу, синтаксис SQL над DataStore.

**Рішення.** Створити **open-source MCP-сервер**, який:

- Перекладає природномовні запити користувача (через Claude, ChatGPT, локальні LLM) у CKAN API виклики.
- Інкапсулює усі особливості CKAN: обробку помилок, пагінацію, фасети, Solr-синтаксис, локалізацію.
- Працює локально (stdio для Claude Desktop) **і** як hosted-сервіс (Streamable HTTP / SSE) — для державних та комерційних AI-агентів.
- Розповсюджується через **DXT-пакет** (drag-and-drop інсталяція в Claude Desktop без жодних залежностей у користувача), **npm**, **Docker**.

**Цільові користувачі.**

| Користувач | Сценарій |
|---|---|
| Громадянин | «Знайди мені дані про закупівлі моєї громади за 2024 рік» |
| Журналіст | «Покажи топ-10 розпорядників за обсягом неоприлюднених датасетів» |
| Аналітик / NGO | «Витягни всі рядки з реєстру боржників для регіону X у форматі CSV» |
| Державний AI-агент (e.g. Dia AI) | Програмний доступ для побудови сервісів автоматичного моніторингу |
| Розробник | Готовий MCP, який не треба реалізовувати з нуля |

**Принципи.**

1. **Доступність** — нульова крива входу для громадянина (DXT install).
2. **Прозорість** — кожна відповідь містить посилання на оригінальний датасет/ресурс.
3. **Безпека** — write-операції лише з API-токеном користувача; жодного зберігання токенів на сервері.
4. **Локалізація** — інтерфейс і помилки українською, метадані повертаються as-is.
5. **Open Source** — MIT-ліцензія, вітчизняна community-розробка.

---

## 2. Поточний стан API `data.gov.ua`

### 2.1. Загальні характеристики

| Параметр | Значення |
|---|---|
| Базовий URL API | `https://opendata.gov.ua/uk_UA/api/3/action/` |
| Фронтенд порталу | `https://data.gov.ua/` |
| Платформа | CKAN 2.x (open-source data portal) |
| Стиль API | Action API (RPC-style over HTTP) |
| Формат запиту | GET (URL params) або POST (JSON body) |
| Формат відповіді | JSON |
| JSONP | Підтримується (`?callback=...`) |
| Авторизація | API token у заголовку `Authorization` |
| Документація | http://docs.ckan.org/en/2.11/api/index.html (загальна CKAN, локального snippet API info на `/uk_UA/api/1/util/snippet/api_info.html`) |

### 2.2. Формат відповіді

```json
{
  "success": true,
  "result": { /* ...payload... */ },
  "help": "https://opendata.gov.ua/uk_UA/api/3/action/help_show?name=package_show"
}
```

У разі помилки:

```json
{
  "success": false,
  "error": {
    "__type": "Validation Error",
    "message": "Resource not found"
  },
  "help": "..."
}
```

> **Увага:** CKAN зазвичай повертає `200 OK` навіть для семантичних помилок. Status-коди `400/409/500` зустрічаються лише при критичних проблемах формату запиту. Тому **завжди треба перевіряти `success`**.

### 2.3. Ключові read-endpoints

#### Каталог датасетів

| Endpoint | Опис |
|---|---|
| `package_list` | Список ID усіх датасетів |
| `package_search?q=...&fq=...&rows=...&start=...&sort=...` | Solr-пошук з фасетами |
| `package_show?id=...` | Повна картка датасету (метадані + ресурси) |
| `current_package_list_with_resources?limit=...&offset=...` | Сторінкований список з ресурсами |
| `recently_changed_packages_activity_list?limit=...` | Стрічка останніх змін |

**`package_search` solr-параметри:**

- `q` — повнотекстовий запит
- `fq` — filter query (`fq=tags:economy`, `fq=organization:kmu`)
- `rows`, `start` — пагінація
- `sort` — `metadata_modified desc`, `views_recent desc`, etc.
- `facet.field=["tags","organization","groups"]` — агрегати
- `include_private`, `include_drafts` (auth-only)

#### Організації, групи, теги

| Endpoint | Опис |
|---|---|
| `organization_list?all_fields=true&limit=...&offset=...` | Розпорядники |
| `organization_show?id=...&include_datasets=true` | Картка розпорядника |
| `group_list?all_fields=true` | Тематичні групи (12 категорій) |
| `group_show?id=derzhava` | Картка групи + датасети |
| `tag_list?query=...` | Усі теги або пошук |
| `tag_show?id=...&include_datasets=true` | Картка тегу |
| `tag_search?query=...&limit=...` | Пошук тегів |

**12 тематичних категорій порталу** (slug → опис):

| Slug | Назва |
|---|---|
| `derzhava` | Держава (державне управління) |
| `podatky` | Державні доходи і видатки (закупівлі, бюджет) |
| `ekonomika` | Економіка та бізнес |
| `energetyka` | Енергетика |
| `transport` | Інфраструктура і транспорт |
| `ekolohiia` | Навколишнє середовище |
| `molod-i-sport` | Освіта, культура, спорт |
| `okhorona-zdorovia` | Охорона здоров'я |
| `rehionalnyi-rozvytok` | Регіональний розвиток |
| `sotsialnyi-zakhyst` | Суспільство |
| `finansy` | Фінанси |
| `iustytsiia` | Юстиція та судочинство |

#### Ресурси (файли в датасетах)

| Endpoint | Опис |
|---|---|
| `resource_show?id=...` | Метадані ресурсу (URL, формат, розмір) |
| `resource_search?query=name:...` | Пошук ресурсів |
| `resource_view_list?id=...` | Візуалізації ресурсу |

#### DataStore (структуровані дані)

| Endpoint | Опис |
|---|---|
| `datastore_search?resource_id=...&q=...&filters={"col":"val"}&fields=...&limit=...&offset=...&sort=...` | Пошук рядків |
| `datastore_search_sql?sql=SELECT * FROM "<resource_id>" WHERE ...` | Повноцінний read-only SQL |
| `datastore_info?id=<resource_id>` | Схема таблиці (колонки, типи) |

**Приклад (з офіційного snippet):**

```
https://opendata.gov.ua/uk_UA/api/3/action/datastore_search?resource_id=2e9a9acc-0502-4ad0-a40e-c71b1f3bf8b1&limit=5
```

```
https://opendata.gov.ua/uk_UA/api/3/action/datastore_search_sql?sql=SELECT * from "2e9a9acc-0502-4ad0-a40e-c71b1f3bf8b1" WHERE title LIKE 'jones'
```

### 2.4. Write-endpoints (потребують `Authorization: <api-token>`)

| Endpoint | Опис |
|---|---|
| `package_create` | Створити датасет |
| `package_update` / `package_patch` | Повне / часткове оновлення |
| `package_delete` | Видалити |
| `resource_create` / `resource_update` / `resource_patch` / `resource_delete` | CRUD ресурсів |
| `datastore_create` | Створити таблицю DataStore |
| `datastore_upsert` | Вставити/оновити рядки |
| `datastore_delete` | Видалити рядки/таблицю |
| `organization_member_create` | Додати користувача до організації |
| `api_token_create` / `api_token_revoke` | Управління токенами |

**Отримання токена:** UI → User Profile → Manage → API tokens.

### 2.5. Транспорт та обмеження

- HTTPS обов'язковий.
- GET підтримується для read-функцій (`/api/3/action/package_search?q=...`).
- POST з JSON body для всього іншого.
- Розмір тіла запиту обмежений (точне значення не задокументоване, орієнтовно 10 MB).
- Rate limiting присутній, але **значення не оприлюднено** в офіційній документації.

---

## 3. Виявлені обмеження та пропозиції покращень API

> Цей розділ адресовано **maintainer'ам `data.gov.ua`** (Мінцифра, ДП «Дія») і є частиною advocacy-стратегії проєкту.

### 3.1. Документація та схеми

**Проблема:** Немає публічного машинно-читаного API контракту.

**Пропозиція:**
- Опублікувати **OpenAPI 3.1** специфікацію для всіх `/api/3/action/*` endpoint'ів.
- Згенерувати її автоматично з CKAN action signatures (вже існують `*.logic.action.*` модулі з типами).
- Розмістити Swagger UI / Redoc на `https://opendata.gov.ua/api-docs`.

### 3.2. Обробка помилок та HTTP-коди

**Проблема:** Семантичні помилки повертаються з `200 OK` + `success: false`. Це порушує REST-семантику й ускладнює моніторинг (load balancer, error tracking бачить «успіх»).

**Пропозиція:**
- Стандартизувати mapping: `Authorization Error → 401/403`, `Not Found → 404`, `Validation Error → 422`, `Server Error → 500`.
- Зберегти `success`/`error` у body для зворотної сумісності.

### 3.3. Rate Limiting

**Проблема:** Ліміти існують але не задокументовані; неможливо коректно реалізувати back-off у клієнтів.

**Пропозиція:**
- Документувати ліміти (наприклад, 60 req/min для анонімних, 300 req/min для токенів).
- Додати заголовки `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`.

### 3.4. Авторизація

**Проблема:** Лише static API token. Немає делегованої авторизації для third-party сервісів.

**Пропозиція:**
- Додати **OAuth 2.0 / OIDC** flow з інтеграцією **Дія.Підпис** (КЕП).
- Scopes: `datasets:read`, `datasets:write`, `org:manage`.
- Refresh tokens, expiry.

### 3.5. Реал-тайм оновлення

**Проблема:** Щоб дізнатись про оновлення, треба polling-ом тягнути `recently_changed_packages_activity_list`.

**Пропозиція:**
- **SSE/WebSocket endpoint** `/api/3/stream/activity` з push-нотифікаціями.
- Альтернатива: **webhooks** із subscription на конкретні датасети / організації / теги.

### 3.6. Масове завантаження

**Проблема:** Щоб скачати всі ресурси датасету, треба окремий HTTP запит на кожен файл.

**Пропозиція:**
- Endpoint `/dataset/<id>/archive.zip` — bundle усіх ресурсів.
- Endpoint `/organization/<id>/archive.zip` — bundle усіх датасетів організації.

### 3.7. DataStore

**Проблема:** DataStore заповнений лише для частини CSV/XLSX ресурсів; для більшості — лише посилання на файл, без SQL-доступу.

**Пропозиція:**
- Автоматичний background job: при публікації CSV/XLSX/JSON парсити в DataStore.
- API для статусу: `datastore_status?resource_id=...`.

### 3.8. Метадані

**Проблема:** Метадані частково англійською, частково українською, неконсистентні; немає машинно-читаних стандартів.

**Пропозиція:**
- Прийняти **DCAT-AP 2.1** (європейський стандарт метаданих відкритих даних) і **schema.org/Dataset** (для SEO).
- Експорт **JSON-LD** на сторінці кожного датасету (`<script type="application/ld+json">`).
- Локалізаційні поля з суфіксами (`title_uk`, `title_en`).

### 3.9. CORS та клієнтська інтеграція

**Проблема:** CORS-політика непрозора; деякі endpoint блокують браузерні запити.

**Пропозиція:**
- Дозволити `Access-Control-Allow-Origin: *` для всіх read-endpoint'ів.
- Окремий subdomain `api.data.gov.ua` без cookie-based auth (тільки Bearer).

### 3.10. Якість даних

**Проблема:** Багато ресурсів — broken links, неактуальні файли, формати без специфікації.

**Пропозиція:**
- Daily health-check job; поле `link_status` (`ok`/`broken`/`unknown`) у відповіді `resource_show`.
- Quality score per dataset (DCAT-AP MQA-сумісний).

### 3.11. Резюме покращень

| Категорія | Пропозиція | Пріоритет |
|---|---|---|
| Docs | OpenAPI 3.1 + Swagger UI | **High** |
| Errors | Стандартні HTTP-коди | **High** |
| Rate limit | Документація + `X-RateLimit-*` headers | **High** |
| Auth | OAuth2 + Дія.Підпис | Medium |
| Realtime | SSE / Webhooks | Medium |
| Bulk | Archive endpoints | Medium |
| DataStore | Auto-populate з файлів | **High** |
| Metadata | DCAT-AP, JSON-LD | Medium |
| CORS | Open read-CORS | Low |
| Quality | Health-check + score | Medium |

---

## 4. Архітектура MCP-сервера

### 4.1. Stack

| Шар | Технологія | Чому |
|---|---|---|
| Мова | **TypeScript** (Node.js 20+) | Найпростіший DXT bundling (~30 MB), один runtime для всіх транспортів, велика community |
| MCP SDK | `@modelcontextprotocol/sdk` | Офіційний, підтримує усі транспорти |
| HTTP-клієнт | `undici` | Швидкий, нативний для Node, streaming |
| Валідація | `zod` | Schema-first, runtime + types, інтегрується з MCP tool schemas |
| Парсинг CSV | `papaparse` | Для `summarize_resource` коли DataStore порожній |
| Тестування | `vitest` + `msw` (mock HTTP) | Швидкі, ESM-friendly |
| Лінт/формат | `eslint` + `prettier` | Стандарт |
| Build | `tsup` (esbuild під капотом) | Один bundle для CJS+ESM, фасадні entry-points |
| Distribution | **DXT** + npm + Docker | Покриває usability + DevOps |

### 4.2. Транспорти

| Транспорт | Entry-point | Сценарій |
|---|---|---|
| **stdio** | `dist/stdio.js` | Claude Desktop, локальний CLI |
| **Streamable HTTP** | `dist/http.js` | Hosted instance, державні AI-агенти |
| **SSE (legacy)** | `dist/sse.js` | Сумісність з ChatGPT custom GPTs та старшими клієнтами |

Усі три обгортають **той самий `createServer()`** з `src/server.ts` — спільні tools/resources/prompts.

### 4.3. Конфігурація

Через env vars (плюс CLI flags для stdio):

| Var | Default | Опис |
|---|---|---|
| `DATA_GOV_UA_BASE_URL` | `https://opendata.gov.ua/uk_UA/api/3/action` | Можна замінити на mirror або dev-portal |
| `DATA_GOV_UA_API_TOKEN` | _empty_ | Якщо вказано, активуються write-tools |
| `DATA_GOV_UA_USER_AGENT` | `opendata-mcp/<version>` | Identifying header |
| `CACHE_TTL_SECONDS` | `300` | LRU TTL для `organization_list`, `group_list`, `tag_list` |
| `HTTP_TIMEOUT_MS` | `30000` | Таймаут запиту |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `PORT` (HTTP/SSE only) | `8080` | Порт сервера |

### 4.4. CKAN Client

`src/ckan/client.ts` — тонкий wrapper:

- Один публічний метод `call<T>(action: string, params?: object, opts?: {token?: string}): Promise<T>`.
- Автоматичний вибір GET (для read) / POST (для write).
- Парсить `{success, result, error}`, кидає типовані помилки (`CkanValidationError`, `CkanAuthError`, `CkanNotFoundError`, `CkanServerError`).
- Retry з exponential backoff на 5xx / network errors (3 спроби).
- Респектує `Retry-After`.
- LRU-кеш для idempotent calls (через `lru-cache`).

### 4.5. Безпека

- **API token** ніколи не логується (redacted у logs).
- Write-tools реєструються в MCP-сервері **лише якщо** `DATA_GOV_UA_API_TOKEN` присутній.
- `sql_query_resource` валідує SQL через regex (заборона `INSERT`, `UPDATE`, `DELETE`, `DROP`, `;`).
- HTTP-сервер за замовчуванням requires Bearer token (`MCP_SERVER_SHARED_SECRET`) у production.
- Rate limiting на серверній стороні через `express-rate-limit` (для hosted).

---

## 5. MCP Tools — повний перелік функцій

> **Конвенція:** імена українські-нейтральні, описи MCP-tool'ів локалізовані українською — LLM розпізнає intent з природної мови. Параметри `zod`-схеми.

### 5.1. Read tools (доступні без токена)

#### 5.1.1. `search_datasets`

Пошук датасетів за ключовими словами, категорією, розпорядником, тегами, форматом файлу.

**Input:**
```ts
{
  q?: string;                    // повнотекстовий запит
  category?: string;             // slug групи (напр. 'podatky')
  organization?: string;         // slug розпорядника
  tags?: string[];               // теги
  format?: string;               // 'CSV' | 'JSON' | 'XLSX' | ...
  limit?: number;                // default 10, max 100
  offset?: number;
  sort?: 'relevance' | 'modified_desc' | 'views_desc' | 'created_desc';
}
```
**CKAN call:** `package_search` з трансляцією filters → `fq` Solr-string.

**Output:** `{count, datasets: [{id, name, title, notes, organization, tags, resources_count, last_modified, url}]}`

#### 5.1.2. `get_dataset`

Повна картка датасету.

**Input:** `{ id: string }` (slug або UUID)
**CKAN call:** `package_show`
**Output:** повний об'єкт з ресурсами, групами, тегами, метаданими.

#### 5.1.3. `list_datasets`

Список усіх ID датасетів (для повного перебору).

**Input:** `{ limit?: number; offset?: number }`
**CKAN call:** `package_list`

#### 5.1.4. `list_organizations`

Список розпорядників.

**Input:** `{ all_fields?: boolean; limit?: number; offset?: number; sort?: 'name'|'package_count'|'title' }`
**CKAN call:** `organization_list`
**Кеш:** так, TTL 5 хв.

#### 5.1.5. `get_organization`

Картка розпорядника + його датасети.

**Input:** `{ id: string; include_datasets?: boolean }`
**CKAN call:** `organization_show`

#### 5.1.6. `list_categories`

12 тематичних категорій. Локально hardcoded + збагачено через `group_list`.

**Input:** _none_
**CKAN call:** `group_list?all_fields=true`
**Output:** `[{slug, title_uk, description_uk, package_count}]`

#### 5.1.7. `get_category`

Картка категорії + її датасети.

**Input:** `{ id: string; include_datasets?: boolean }`
**CKAN call:** `group_show`

#### 5.1.8. `list_tags`

Усі теги або пошук.

**Input:** `{ query?: string; limit?: number }`
**CKAN call:** `tag_search` (якщо query) або `tag_list`

#### 5.1.9. `get_resource`

Метадані конкретного ресурсу.

**Input:** `{ id: string }`
**CKAN call:** `resource_show`

#### 5.1.10. `search_resources`

Пошук ресурсів за полями (`name`, `format`).

**Input:** `{ query: Record<string,string>; order_by?: string; limit?: number; offset?: number }`
**CKAN call:** `resource_search`

#### 5.1.11. `query_resource`

Пошук рядків у DataStore конкретного ресурсу.

**Input:**
```ts
{
  resource_id: string;
  q?: string | Record<string, string>;
  filters?: Record<string, string | number>;
  fields?: string[];
  limit?: number;
  offset?: number;
  sort?: string;
}
```
**CKAN call:** `datastore_search`

#### 5.1.12. `sql_query_resource`

Виконати read-only SQL над DataStore.

**Input:** `{ sql: string }`
**CKAN call:** `datastore_search_sql`
**Валідація:** заборона DML/DDL keywords.

#### 5.1.13. `get_resource_schema`

Схема таблиці DataStore (колонки, типи).

**Input:** `{ resource_id: string }`
**CKAN call:** `datastore_info`

#### 5.1.14. `recent_changes`

Стрічка нещодавніх оновлень.

**Input:** `{ limit?: number }`
**CKAN call:** `recently_changed_packages_activity_list`

#### 5.1.15. `download_resource`

Скачати файл ресурсу.

**Input:** `{ resource_id: string; max_bytes?: number }`
**Behavior:** `resource_show` → fetch URL → повернути bytes (base64) або, якщо файл >max_bytes, повернути metadata + посилання.

#### 5.1.16. `summarize_resource`

Швидкий аналіз ресурсу (типи колонок, кількість рядків, sample, базова статистика).

**Input:** `{ resource_id: string; sample_size?: number }`
**Behavior:**
1. `datastore_info` для схеми.
2. Якщо DataStore заповнений — `datastore_search` з `limit=sample_size`.
3. Якщо ні — `download_resource` (CSV/JSON/XLSX) → парсинг локально (`papaparse` або streaming JSON).
4. Повернути summary.

**Output:**
```ts
{
  rows_total?: number;
  columns: [{name, type, sample_values, nulls_count?, unique_values?}];
  preview: object[];
  notes: string[];   // напр. "DataStore відсутній, парсили перші 100 рядків CSV"
}
```

### 5.2. Write tools (вимагають `DATA_GOV_UA_API_TOKEN`)

> Реєструються в MCP-сервері умовно: `if (config.apiToken) registerWriteTools(server)`.

#### 5.2.1. `create_dataset`

**Input:**
```ts
{
  name: string;            // slug, unique
  title: string;
  notes?: string;
  owner_org: string;       // id розпорядника
  license_id?: string;
  tags?: string[];
  groups?: string[];
  resources?: Array<{ url: string; name?: string; format?: string; description?: string }>;
  private?: boolean;
}
```
**CKAN call:** `package_create`

#### 5.2.2. `update_dataset`

**Input:** `{ id: string; patch: object }` (часткове оновлення)
**CKAN call:** `package_patch`

#### 5.2.3. `delete_dataset`

**Input:** `{ id: string }`
**CKAN call:** `package_delete`

#### 5.2.4. `create_resource`

**Input:** `{ package_id: string; url: string; name?: string; format?: string; description?: string; mimetype?: string }`
**CKAN call:** `resource_create`

#### 5.2.5. `update_resource`

**Input:** `{ id: string; patch: object }`
**CKAN call:** `resource_patch`

#### 5.2.6. `delete_resource`

**Input:** `{ id: string }`
**CKAN call:** `resource_delete`

#### 5.2.7. `upsert_datastore`

**Input:** `{ resource_id: string; records: object[]; method?: 'upsert'|'insert'|'update' }`
**CKAN call:** `datastore_upsert`

#### 5.2.8. `create_datastore_table`

**Input:** `{ resource_id: string; fields: Array<{id: string; type: string}>; primary_key?: string[] }`
**CKAN call:** `datastore_create`

### 5.3. Підсумкова таблиця tools

| Tool | CKAN action | Auth |
|---|---|---|
| `search_datasets` | `package_search` | — |
| `get_dataset` | `package_show` | — |
| `list_datasets` | `package_list` | — |
| `list_organizations` | `organization_list` | — |
| `get_organization` | `organization_show` | — |
| `list_categories` | `group_list` | — |
| `get_category` | `group_show` | — |
| `list_tags` | `tag_list` / `tag_search` | — |
| `get_resource` | `resource_show` | — |
| `search_resources` | `resource_search` | — |
| `query_resource` | `datastore_search` | — |
| `sql_query_resource` | `datastore_search_sql` | — |
| `get_resource_schema` | `datastore_info` | — |
| `recent_changes` | `recently_changed_packages_activity_list` | — |
| `download_resource` | (fetch URL) | — |
| `summarize_resource` | (composite) | — |
| `create_dataset` | `package_create` | ✔ |
| `update_dataset` | `package_patch` | ✔ |
| `delete_dataset` | `package_delete` | ✔ |
| `create_resource` | `resource_create` | ✔ |
| `update_resource` | `resource_patch` | ✔ |
| `delete_resource` | `resource_delete` | ✔ |
| `upsert_datastore` | `datastore_upsert` | ✔ |
| `create_datastore_table` | `datastore_create` | ✔ |

**Усього: 24 tools** (16 read + 8 write).

---

## 6. MCP Resources та Prompts

### 6.1. Resources (URI-адресовані)

| URI | Опис |
|---|---|
| `catalogue://categories` | Список 12 категорій (JSON) |
| `catalogue://organizations` | Кеш списку розпорядників |
| `dataset://{id}` | Метадані датасету (зручно для embedding в context) |
| `resource://{id}` | Метадані ресурсу |
| `resource://{id}/schema` | Schema DataStore |

### 6.2. Prompts (шаблони взаємодії)

| Prompt | Аргументи | Призначення |
|---|---|---|
| `find_dataset` | `topic: string` | Покроковий guided-пошук: уточнення категорії → пошук → фільтрація → вибір |
| `compare_datasets` | `id_a: string, id_b: string` | Порівняння двох датасетів (метадані, покриття, оновлюваність) |
| `analyze_spending` | `region?: string, year?: string` | Кейс: держвидатки за регіоном/роком |
| `track_register` | `register_name: string` | Моніторинг змін у конкретному реєстрі |
| `quality_audit` | `organization?: string` | Аудит якості датасетів розпорядника (broken links, оновлюваність) |

---

## 7. Структура проєкту

```
opendata-mcp/
├── src/
│   ├── stdio.ts                    # entry-point: stdio transport
│   ├── http.ts                     # entry-point: Streamable HTTP
│   ├── sse.ts                      # entry-point: SSE (legacy)
│   ├── server.ts                   # createServer() — спільна MCP-фабрика
│   ├── config.ts                   # env vars + validation (zod)
│   ├── ckan/
│   │   ├── client.ts               # HTTP wrapper, retry, кеш
│   │   ├── types.ts                # zod schemas: Package, Resource, Organization, Group, Tag
│   │   ├── errors.ts               # CkanError ієрархія
│   │   └── solr.ts                 # builder для fq-string
│   ├── tools/
│   │   ├── read/
│   │   │   ├── search-datasets.ts
│   │   │   ├── get-dataset.ts
│   │   │   ├── list-organizations.ts
│   │   │   ├── ... (по файлу на tool)
│   │   ├── datastore/
│   │   │   ├── query-resource.ts
│   │   │   ├── sql-query.ts
│   │   │   └── get-schema.ts
│   │   ├── analysis/
│   │   │   ├── download-resource.ts
│   │   │   └── summarize-resource.ts
│   │   └── write/
│   │       ├── create-dataset.ts
│   │       ├── ... (по файлу)
│   ├── resources/
│   │   ├── categories.ts
│   │   ├── organizations.ts
│   │   └── dataset.ts
│   ├── prompts/
│   │   ├── find-dataset.ts
│   │   ├── compare-datasets.ts
│   │   └── ...
│   ├── util/
│   │   ├── cache.ts                # LRU
│   │   ├── logger.ts               # pino з redaction
│   │   └── csv.ts                  # papaparse helpers
│   └── index.ts                    # public exports (для npm consumers)
├── dxt/
│   ├── manifest.json               # DXT manifest (name, version, entry, capabilities)
│   ├── icon.png
│   └── README.md                   # короткий опис у DXT-store
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/                   # recorded CKAN responses
├── scripts/
│   ├── build-dxt.ts                # генерує .dxt файл
│   └── record-fixtures.ts          # перезаписує fixtures з live API
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  # lint, test, build
│   │   ├── release.yml             # publish npm, build DXT, push Docker
│   │   └── dxt-validate.yml
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.md           # укр + англ
│       └── feature_request.md
├── docs/
│   ├── usage-uk.md
│   ├── usage-en.md
│   ├── tools-reference.md
│   └── contributing.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── .eslintrc.json
├── .prettierrc
├── README.md                       # quick-start (англ)
├── README-uk.md                    # quick-start (укр)
├── PLAN.md                         # цей документ
├── LICENSE                         # MIT
└── CHANGELOG.md
```

---

## 8. Roadmap (фази розробки)

### Phase 0 — Scaffolding (1 день)

- `package.json`, `tsconfig.json`, `tsup`, `vitest`, `eslint`, `prettier`.
- Базовий `src/server.ts` з MCP SDK.
- `src/ckan/client.ts` з одним методом + типи.
- `src/stdio.ts` запускається.
- Tools: `search_datasets`, `get_dataset` (smoke).
- Manual test: підключити в Claude Desktop через `claude_desktop_config.json`.

### Phase 1 — Read tools complete (2–3 дні)

- Усі 16 read tools.
- LRU-кеш.
- Resources (5 шт.).
- Prompts (5 шт.).
- Unit tests з `msw` fixtures.
- Документація `docs/tools-reference.md`.

### Phase 2 — Write tools (2 дні)

- Усі 8 write tools.
- Token validation.
- Інтеграційні тести проти CKAN demo instance (опційно — staging порталу).
- Audit log для write-операцій (лише локально, нічого не зливаємо назовні).

### Phase 3 — Streamable HTTP / SSE (1–2 дні)

- `src/http.ts`, `src/sse.ts`.
- Authentication middleware (Bearer shared secret).
- Rate limiting.
- Health check `/healthz`.
- Docker image, multi-arch (amd64 + arm64).

### Phase 4 — DXT та distribution (1 день)

- `dxt/manifest.json`.
- `scripts/build-dxt.ts` → `.dxt` artifact у CI.
- npm publish (`@opendata-ua/mcp-server`).
- Docker push на GHCR.
- README з install інструкціями (укр + англ).
- Скріншоти + GIF використання.

### Phase 5 — Hosted instance + community (тривалий)

- Reference deploy на Cloudflare Workers або Fly.io (`https://mcp.opendata-ua.org`).
- Public MCP Inspector посилання для тестування.
- Анонс у:
  - Telegram-каналах відкритих даних України
  - dev-Telegram (Ukrainian DevRel)
  - Mailing list розпорядників через Мінцифру
  - GitHub Discussions
- Sponsorship: GitHub Sponsors, Patreon, Open Collective.
- Періодичні релізи (semver).

### Phase 6 — Розширення (бек-лог)

- `analyze_spending` smart-tool з агрегатами по бюджетних даних.
- Інтеграція з `prozorro.gov.ua` API (закупівлі) як окремий модуль.
- Інтеграція з YouControl / OpenDataBot (compliance check).
- Підтримка інших CKAN-порталів (Європа, локальні муніципальні).
- Embedding-based семантичний пошук (sqlite-vss локально).

---

## 9. Тестування та верифікація

### 9.1. Автоматизовані тести

| Рівень | Інструмент | Покриття |
|---|---|---|
| Unit | `vitest` | CKAN client, builders, валідація |
| Integration | `vitest` + `msw` | Кожен tool з recorded fixtures |
| E2E (manual) | MCP Inspector | Запуск сервера, виклик кожного tool |
| Smoke (CI) | curl + Docker | `/healthz`, `list_tools` через HTTP |

### 9.2. Acceptance criteria (Phase 1 готовий, коли...)

1. Користувач у Claude Desktop пише:
   > «Знайди мені реєстр боржників за 2024 рік»

   Сервер викликає `search_datasets({q: "реєстр боржників", sort: "modified_desc"})`, повертає список, LLM пропонує найкращий варіант.

2. Користувач пише:
   > «Покажи мені перші 10 рядків з ресурсу 2e9a9acc-0502-4ad0-a40e-c71b1f3bf8b1»

   Сервер викликає `query_resource({resource_id: "2e9a9acc-...", limit: 10})`, повертає рядки.

3. Користувач пише:
   > «Які розпорядники опублікували найбільше датасетів про екологію?»

   Сервер викликає `list_organizations({sort: "package_count"})` + фільтр по `group=ekolohiia`, агрегує, повертає рейтинг.

4. Lint + typecheck + tests зелені у CI.

### 9.3. Acceptance criteria (DXT готовий, коли...)

- `.dxt` файл збирається у CI.
- Інстальований у Claude Desktop через drag-and-drop, без жодних додаткових кроків.
- При першому запуску запитує у користувача (опційно) API token через DXT user-config UI.
- Виконує усі 16 read tools.

### 9.4. Acceptance criteria (Hosted готовий, коли...)

- Публічний URL відповідає на MCP handshake.
- Документація `mcp.opendata-ua.org/docs` з прикладами для claude.ai та ChatGPT.
- Підключення з MCP Inspector працює.
- 99.9% uptime за 30 днів.

---

## 10. Ліцензія, community та поширення

### 10.1. Ліцензія

**MIT License** — максимально дозволяюча, сумісна з державними проєктами та комерційним використанням.

### 10.2. Governance

- Maintainers: відкритий список у `MAINTAINERS.md`.
- Code of Conduct: Contributor Covenant 2.1.
- PR review: мінімум 1 maintainer approval.
- Semver: `MAJOR.MINOR.PATCH`.
- Release cadence: minor — раз на 4 тижні, patch — за потребою.

### 10.3. Канали комунікації

- GitHub Issues / Discussions (основний).
- Telegram-група `@opendata_ua_dev` (запропонувати створити).
- Mailing list з maintainer'ами.

### 10.4. Документація

| Файл | Аудиторія |
|---|---|
| `README.md` (en) | Розробники, AI engineers |
| `README-uk.md` | Українська спільнота |
| `docs/usage-uk.md` | Громадянин: як встановити в Claude Desktop |
| `docs/tools-reference.md` | API-reference для kожного tool |
| `docs/contributing.md` | Розробники |
| `docs/api-improvements.md` | Цей розділ (#3) — для Мінцифри |

### 10.5. Партнерства

- **Мінцифра / ДП «Дія»** — координація щодо API improvements.
- **Texty.org.ua, OPORA, Чесно** — журналістські use-кейси.
- **Українські AI-стартапи** — продакшн-користувачі.
- **EU OpenData Portal** — обмін best practices, можливе розширення на DCAT-AP.

---

## Додаток A — Приклад tool definition (TypeScript)

```ts
// src/tools/read/search-datasets.ts
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/server";
import { CkanClient } from "../../ckan/client.js";

const inputSchema = z.object({
  q: z.string().optional().describe("Повнотекстовий запит"),
  category: z.string().optional().describe("Slug категорії, напр. 'podatky'"),
  organization: z.string().optional().describe("Slug розпорядника"),
  tags: z.array(z.string()).optional(),
  format: z.string().optional().describe("'CSV' | 'JSON' | 'XLSX' | ..."),
  limit: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(["relevance", "modified_desc", "views_desc", "created_desc"]).default("relevance"),
});

export const searchDatasets = (ckan: CkanClient): Tool => ({
  name: "search_datasets",
  description:
    "Пошук датасетів на data.gov.ua за ключовими словами, категорією, розпорядником, тегами або форматом файлу. Повертає список з ID, назвами та посиланнями.",
  inputSchema,
  handler: async (input) => {
    const params = buildPackageSearchParams(input);
    const result = await ckan.call("package_search", params);
    return formatSearchResult(result);
  },
});
```

## Додаток B — Приклад DXT manifest

```json
{
  "dxt_version": "0.1",
  "name": "opendata-ua-mcp",
  "display_name": "Відкриті дані України (data.gov.ua)",
  "version": "0.1.0",
  "description": "MCP-сервер для роботи з порталом відкритих даних України",
  "author": { "name": "Open Data UA Community" },
  "license": "MIT",
  "server": {
    "type": "node",
    "entry_point": "dist/stdio.js",
    "mcp_config": { "command": "node", "args": ["${__dirname}/dist/stdio.js"] }
  },
  "user_config": [
    {
      "key": "DATA_GOV_UA_API_TOKEN",
      "type": "string",
      "title": "API Token (опційно — для write-операцій)",
      "sensitive": true,
      "required": false
    }
  ]
}
```

---

**Версія документа:** 0.1 — 2026-05-15
**Автор:** Open Data UA Community (initial draft)
**Контакти / Issues:** GitHub репозиторій (буде створено на старті розробки)
