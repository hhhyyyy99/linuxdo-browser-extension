# Research: LinuxDo Forum Structure

- **Query**: Understand linux.do forum platform, URL structure, DOM, APIs, pagination
- **Scope**: External (web research via GitHub repos of existing extensions/tools)
- **Date**: 2026-06-22

## 1. Platform Type

**LinuxDo (linux.do) is a Discourse-based forum.** Confirmed by multiple independent sources:

- [mrsxs/linuxdo-mcp](https://github.com/mrsxs/linuxdo-mcp) -- MCP server that directly calls standard Discourse JSON endpoints
- [YOLO-9257/linuxdo-agent](https://github.com/YOLO-9257/linuxdo-agent) -- Userscript using Discourse API
- [xiaohuihui202504/linuxdo-helper-extension](https://github.com/xiaohuihui202504/linuxdo-helper-extension) -- Chrome extension using Discourse DOM

**Cloudflare Protection**: The site is behind Cloudflare challenge ("5-second shield"). Direct curl/fetch from non-browser contexts gets blocked with a "Just a moment..." page. To bypass:
- Use a real browser (content scripts, userscripts)
- Impersonate Chrome TLS fingerprint (e.g., `curl_cffi` with `impersonate="chrome"`)
- Provide valid `_t` cookie (Discourse session token)

**Related domains** (same ecosystem):
- `connect.linux.do` -- Login/OAuth
- `credit.linux.do` -- Credit/points system
- `cdk.linux.do` -- CDK community score
- `idcflare.com` -- Related forum (same Discourse codebase)

---

## 2. URL Structure

### Page URLs (HTML)

| Purpose | URL Pattern |
|---|---|
| Homepage / Latest topics | `https://linux.do/latest` |
| Topic detail | `https://linux.do/t/{slug}/{topic_id}` |
| Topic detail (simplified) | `https://linux.do/t/topic/{topic_id}` |
| Topic with specific post | `https://linux.do/t/{slug}/{topic_id}/{post_number}` |
| Category listing | `https://linux.do/c/{category_slug}/{category_id}` |
| Tag listing | `https://linux.do/tag/{tag_name}` |
| User profile | `https://linux.do/u/{username}` |
| Search | `https://linux.do/search` |

### JSON API URLs

| Purpose | URL Pattern | Response key for topics |
|---|---|---|
| Latest topics | `/latest.json?page={page}` | `topic_list.topics[]` |
| Top topics | `/top.json?period={period}&page={page}` | `topic_list.topics[]` |
| Unread topics | `/unread.json?per_page={n}` | `topic_list.topics[]` |
| Topic detail + first posts | `/t/{topic_id}.json` | `post_stream.posts[]` + `post_stream.stream[]` |
| Additional posts (batch) | `/t/{topic_id}/posts.json?post_ids[]=X&post_ids[]=Y` | `post_stream.posts[]` |
| Search | `/search.json?q={query}&page={page}&include_blurbs=true` | `posts[]` + `topics[]` |
| Categories list | `/categories.json` | `category_list.categories[]` |
| Category topics | `/c/{slug}/{category_id}.json?page={page}` | `topic_list.topics[]` |
| Tag topics | `/tag/{tag}.json?page={page}` | `topic_list.topics[]` |
| All tags | `/tags.json` | `tags[]` |
| User profile | `/u/{username}.json` | `user` |
| User summary | `/u/{username}/summary.json` | `user_summary` |
| User actions | `/user_actions.json?offset=0&username={u}&filter=4,5` | `user_actions[]` |
| Current session | `/session/current.json` | `current_user` |
| Site metadata | `/site.json` | `categories[]` (with subcategories) |
| Individual post | `/posts/{post_id}.json` | `post` |
| CSRF token | `meta[name="csrf-token"]` (HTML attribute) | -- |

---

## 3. DOM Structure

Discourse uses Ember.js for rendering. Key DOM selectors found from existing extensions:

### Topic List Page (`/latest`, `/top`, etc.)

Discourse is an SPA (Single Page Application) built on Ember.js. Topic lists are rendered client-side. The DOM is dynamically generated.

**Key selectors for topic list items:**
- Topic rows are rendered by Ember components
- `.topic-list-item` -- individual topic row
- `.topic-title` / `.main-link` -- topic title area
- `.topic-category a`, `.category-name`, `.badge-category-bg` -- category badges
- `.loading`, `.infinite-scroll` -- loading indicators (useful for detecting page load state)

**Fetching topic lists programmatically is more reliable via JSON API** (`/latest.json`) than scraping DOM, since the Ember-rendered DOM is complex and changes between Discourse versions.

### Topic Detail Page (`/t/{slug}/{id}`)

- `.topic-post` -- individual post containers (each post in the topic)
- `.discourse-reactions-reaction-button` -- like/reaction button (Discourse Reactions plugin)
- `.discourse-reactions-counter` / `.reaction-count` / `.like-count` -- like count display
- `.like-button` / `.like-button.has-like` -- alternative like button classes
- `meta[name="csrf-token"]` -- CSRF token for write operations (likes, posts)

### General

- `meta[name="csrf-token"]` -- required for any authenticated write API calls
- Discourse uses `credentials: "same-origin"` and `X-Requested-With: XMLHttpRequest` headers
- For authenticated JSON API: send `Accept: application/json` header

---

## 4. JSON API Details

### Authentication

- Session cookie `_t` is the primary auth token
- CSRF token from `meta[name="csrf-token"]` needed for POST/PUT/DELETE
- Headers for API calls:
  ```
  Accept: application/json
  X-Requested-With: XMLHttpRequest
  Cookie: _t={token}
  ```
- For write operations, add:
  ```
  Content-Type: application/json
  X-CSRF-Token: {csrf_token}
  ```

### Latest Topics Response (`/latest.json`)

```json
{
  "topic_list": {
    "topics": [
      {
        "id": 123456,
        "title": "Topic Title",
        "fancy_title": "Topic Title",  // may include emoji
        "slug": "topic-slug",
        "category_id": 42,
        "posts_count": 15,
        "views": 1234,
        "like_count": 56,
        "created_at": "2025-01-01T00:00:00.000Z",
        "bumped_at": "2025-01-02T00:00:00.000Z",
        "tags": ["tag1", "tag2"],
        // ... more fields
      }
    ],
    "more_topics_url": "/latest.json?param=value"  // null if no more pages
  }
}
```

### Topic Detail Response (`/t/{id}.json`)

```json
{
  "id": 123456,
  "title": "Topic Title",
  "slug": "topic-slug",
  "category_id": 42,
  "posts_count": 50,
  "views": 1000,
  "like_count": 30,
  "tags": ["tag1"],
  "post_stream": {
    "posts": [
      {
        "id": 999001,
        "post_number": 1,
        "username": "author",
        "created_at": "...",
        "cooked": "<p>HTML content</p>",
        "like_count": 10,
        // ... more fields
      }
    ],
    "stream": [999001, 999002, 999003, ...]  // ALL post IDs in order
  }
}
```

**Important**: Initial response only includes ~20 posts in `post_stream.posts[]`. The `stream[]` array contains ALL post IDs. To get additional posts, batch-fetch via `/t/{id}/posts.json?post_ids[]=X&post_ids[]=Y` (batch size ~20).

### Search Response (`/search.json`)

```json
{
  "posts": [
    {
      "topic_id": 123456,
      "post_number": 1,
      "username": "user",
      "blurb": "matching text excerpt...",
      "created_at": "..."
    }
  ],
  "topics": [
    { "id": 123456, "title": "...", "category_id": 42, "tags": [...] }
  ],
  "categories": [
    { "id": 42, "name": "Category Name" }
  ],
  "grouped_search_result": {
    "term": "search query",
    "more_full_page_results": true/false
  }
}
```

### Categories Response (`/categories.json`)

```json
{
  "category_list": {
    "categories": [
      {
        "id": 42,
        "slug": "dev",
        "name": "Development",
        "topic_count": 500,
        "post_count": 5000,
        "minimum_required_trust_level": 1,
        "description_text": "...",
        "subcategory_ids": [43, 44]
      }
    ]
  }
}
```

**Note**: On linux.do, category names sometimes encode trust level requirements as a suffix like `"Development, Lv1"`. The `site.json` endpoint provides the full category tree including subcategories.

---

## 5. Pagination

### Topic Lists (Latest, Top, Category Topics, Tag Topics)

- **Page parameter**: `?page={page_number}` (0-based or 1-based, varies by endpoint; `/latest.json` uses 1-based in practice)
- **Page size**: ~30 topics per page
- **Has-more indicator**: `topic_list.more_topics_url` -- if non-null, there are more pages
- **Per-page override**: `?per_page={n}` can adjust page size (seen in `/unread.json`)

### Posts Within a Topic

Discourse loads topics in two phases:

1. **Initial load**: `/t/{id}.json` returns the first ~20 posts in `post_stream.posts[]`, plus the full `post_stream.stream[]` array of ALL post IDs
2. **Batch fetch**: Use `/t/{id}/posts.json?post_ids[]=X&post_ids[]=Y` to load additional posts in batches of ~20 IDs

This is the standard Discourse "streaming" pattern for large topics.

### Search Results

- **Page parameter**: `?page={page_number}` (1-based)
- **Page size**: ~50 results per page
- **Has-more indicator**: `grouped_search_result.more_full_page_results` (boolean)

---

## 6. Key Categories on LinuxDo

From the linuxdo-helper-extension configuration, known categories include:

| Category | Description |
|---|---|
| Development/Tuning (开发调优) | Development discussion |
| Domestic Alternatives (国产替代) | Chinese software alternatives |
| Resources (资源荟萃) | Resource sharing |
| Documentation (文档共建) | Collaborative docs |
| General Chat (搞七捻三) | Off-topic |
| Community Incubation (社区孵化) | Community projects |
| Operations Feedback (运营反馈) | Site feedback |
| Welfare/Deals (福利羊毛) | Deals and freebies |

**Trust Level System**: LinuxDo uses Discourse's trust level system (Lv0-Lv4) with some categories requiring minimum trust levels to access.

---

## 7. Existing Extension Implementations

### mrsxs/linuxdo-mcp (MCP Server, Python)
- Uses `curl_cffi` to impersonate Chrome TLS fingerprint
- Auth: `_t` cookie only (no `cf_clearance` needed)
- Implements all major read-only API endpoints
- Source: `src/linuxdo_mcp/server.py`

### xiaohuihui202504/linuxdo-helper-extension (Chrome Extension, MV3)
- Auto-scroll, auto-like, topic navigation
- Uses `/latest.json` and `/unread.json` for topic lists
- Uses `window.location.pathname.match(/\/t\/topic\/(\d+)/)` for topic ID detection
- Reads `.topic-post`, `.discourse-reactions-reaction-button` from DOM

### YOLO-9257/linuxdo-agent (Userscript)
- Full Discourse API integration in `DiscourseAPI` class
- Uses `fetch()` with `credentials: "same-origin"`
- Reads CSRF token from `meta[name="csrf-token"]`

---

## Caveats

1. **Cloudflare**: All programmatic access must handle Cloudflare challenge. Browser extensions with content scripts running on the page avoid this issue since the browser handles CF challenges naturally.

2. **Rate Limiting**: The site returns HTTP 429 when rate-limited. Extensions should implement reasonable delays between requests.

3. **Trust Level Gated Content**: Some categories require minimum trust level. API responses may omit content for insufficient trust levels.

4. **Topic URL Variation**: Two URL patterns exist: `/t/{slug}/{id}` (canonical) and `/t/topic/{id}` (simplified). Both work; the slug is optional.

5. **Discourse Version**: The specific Discourse version may affect available API fields. The site uses Discourse with the Discourse Reactions plugin (evidenced by `.discourse-reactions-reaction-button` class).
