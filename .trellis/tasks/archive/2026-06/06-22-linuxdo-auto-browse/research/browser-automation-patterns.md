# Research: Browser Automation Patterns for LinuxDo Auto-Browse Extension

- **Query**: Research kimi-webbridge architecture, Chrome extension patterns for auto-scrolling/clicking/navigating within a single tab, and similar open-source projects
- **Scope**: mixed (internal kimi-webbridge skill analysis + external browser automation patterns)
- **Date**: 2026-06-22

## Findings

### 1. Kimi WebBridge Architecture

Kimi WebBridge is a **local daemon + Chrome extension** architecture that lets AI control a real browser.

**Components:**

| Component | Location | Role |
|---|---|---|
| Daemon binary | `~/.kimi-webbridge/bin/kimi-webbridge` | Go binary, HTTP server on `127.0.0.1:10086` |
| Chrome Extension | Installed from Chrome Web Store | Connects to daemon via **WebSocket** |
| AI Agent Skill | `~/.claude/skills/kimi-webbridge/SKILL.md` | Tells AI how to call the daemon API |

**Communication flow:**

```
AI Agent --HTTP POST--> Daemon (:10086) --WebSocket--> Chrome Extension --DOM API--> Web Page
```

**Protocol details:**
- Daemon exposes `POST http://127.0.0.1:10086/command`
- Request body: `{"action": "<action>", "args": {...}, "session": "<name>"}`
- Available actions: `navigate`, `find_tab`, `snapshot`, `click`, `fill`, `evaluate`, `screenshot`, `network`, `upload`, `save_as_pdf`, `list_tabs`, `close_tab`, `close_session`
- Extension connects back to daemon via WebSocket (status endpoint shows `extension_connected: true/false`)
- Sessions map to browser tab groups; different session names isolate operations

**Key design decisions (relevant to our extension):**
- Uses **DOM-level synthetic events** (`el.click()`, native setter for `.value`) — NOT Chrome DevTools Protocol
- `snapshot` returns an **accessibility tree** with `@e` refs for element targeting (role/name-based, survives CSS hash changes)
- `evaluate` runs arbitrary JS in the page's JS realm (shared scope — must use IIFE to avoid re-declaration errors)
- Sites that check `event.isTrusted` (banking, captcha) cannot be automated this way — this is a known limitation
- Cross-origin iframes require direct navigation to iframe URL

### 2. Kimi WebBridge vs Our Extension (Critical Difference)

Kimi WebBridge is an **external AI-to-browser bridge** (daemon + extension). Our LinuxDo auto-browse extension is a **self-contained Chrome extension** — all logic runs inside the extension itself, no external daemon needed.

**What we can learn from kimi-webbridge:**
- The `evaluate` pattern for DOM manipulation is directly applicable
- The `snapshot`/`@e` ref pattern for element targeting is overkill for us (we know the Discourse DOM structure)
- Synthetic `click()` works fine for Discourse (no `isTrusted` checks on forum links)
- The session concept is irrelevant — we only operate on one tab

### 3. Chrome Extension Manifest V3 Architecture for This Use Case

**Recommended architecture:**

```
background.js (Service Worker)
  ├── Manages extension state (running/stopped)
  ├── Handles icon click → popup or side panel
  └── Communicates with content script via chrome.runtime messaging

content.js (Content Script, injected into linux.do)
  ├── DOM manipulation (scroll, click, read)
  ├── Navigation interception (prevent new tabs)
  ├── Discourse SPA awareness (Ember.js route changes)
  └── Reports page state back to background

popup.html / popup.js (Control UI)
  └── Start/Stop/Settings controls
```

**Manifest V3 key fields:**

```json
{
  "manifest_version": 3,
  "name": "LinuxDo Auto Browse",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["https://linux.do/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://linux.do/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup.html" }
}
```

### 4. Content Script Patterns for DOM Manipulation

**Auto-scrolling (simulate human reading):**

```javascript
// Smooth scroll with random speed variation (human-like)
function autoScroll(options = {}) {
  const { minSpeed = 1, maxSpeed = 3, interval = 50 } = options;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const distance = minSpeed + Math.random() * (maxSpeed - minSpeed);
      window.scrollBy({ top: distance, behavior: 'auto' }); // 'auto' not 'smooth' for granular control
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight) {
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });
}
```

**Key scrolling considerations:**
- Use `window.scrollBy()` with `'auto'` behavior for granular pixel-level control (not `'smooth'` which is browser-controlled)
- Add random variation to scroll speed and pause intervals (human-like jitter)
- Check `window.scrollY + window.innerHeight >= document.documentElement.scrollHeight` for "reached bottom"
- Discourse lazy-loads content — may need to wait for new posts to load before declaring "bottom reached"
- Consider `IntersectionObserver` to detect when post content enters/exits viewport

**Clicking links without opening new tabs:**

```javascript
// Method 1: Intercept click events on links
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (link && shouldIntercept(link)) {
    e.preventDefault();
    e.stopPropagation();
    // Navigate within SPA or via location
    navigateInSameTab(link.href);
  }
}, true); // capture phase to intercept before Discourse handlers

// Method 2: Direct navigation for known URLs
function navigateInSameTab(url) {
  window.location.href = url;
}
```

### 5. Single-Tab Navigation in Discourse SPA

**Discourse (Ember.js) specifics:**
- Discourse uses Ember.js with its own router (`DiscourseURL` module)
- Internal links use `data-auto-route` attribute
- Route changes are handled by Ember's router — page doesn't fully reload
- `api.getCurrentUser()` and `api.getSiteSettings()` are available in the Discourse plugin API

**Best approach for single-tab navigation:**

```javascript
// Intercept all link clicks within Discourse
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (!link) return;

  const url = new URL(link.href, window.location.origin);

  // Only intercept same-origin links
  if (url.origin !== window.location.origin) return;

  // Let Discourse's own router handle it (stays in same tab)
  // But prevent target="_blank" behavior
  if (link.target === '_blank') {
    e.preventDefault();
    e.stopPropagation();
    link.target = '_self';
    // Re-dispatch or navigate directly
    window.location.href = url.href;
    return;
  }

  // For normal links, Discourse's Ember router handles navigation
  // No action needed — it already stays in same tab
}, true);
```

**Critical insight:** Discourse links generally stay in the same tab by default. The `target="_blank"` pattern is rare on standard topic links. The main challenge is NOT preventing new tabs — it's detecting when navigation completes (Ember route change).

**Detecting SPA route changes:**

```javascript
// Method 1: MutationObserver on document.title
const titleObserver = new MutationObserver(() => {
  onRouteChange(window.location.href);
});
titleObserver.observe(document.querySelector('title'), { childList: true });

// Method 2: Override pushState/replaceState
const originalPushState = history.pushState;
history.pushState = function(...args) {
  originalPushState.apply(this, args);
  onRouteChange(window.location.href);
};

// Method 3: popstate event for back/forward
window.addEventListener('popstate', () => {
  onRouteChange(window.location.href);
});

// Method 4: Discourse-specific — observe #main-outlet content change
const mainOutlet = document.querySelector('#main-outlet');
if (mainOutlet) {
  const contentObserver = new MutationObserver((mutations) => {
    // Page content changed — new topic loaded
    onPageReady();
  });
  contentObserver.observe(mainOutlet, { childList: true, subtree: true });
}
```

### 6. The Browse Loop Architecture

The core automation loop for this extension:

```javascript
async function browseLoop() {
  while (isRunning) {
    // 1. Get list of topic links from current page
    const topics = getTopicLinks(); // querySelectorAll('.topic-list-item a.title')

    for (const topic of topics) {
      if (!isRunning) break;

      // 2. Click topic link (stays in same tab via Ember router)
      topic.click();

      // 3. Wait for topic page to load
      await waitForElement('.topic-body, #post_1');
      await randomDelay(1000, 3000); // human-like pause

      // 4. Slowly scroll through the topic
      await autoScroll({ minSpeed: 1, maxSpeed: 4, interval: 50 });

      // 5. Random pause at bottom (simulate reading)
      await randomDelay(2000, 5000);

      // 6. Navigate back to topic list
      window.history.back(); // or click "Back" button
      await waitForElement('.topic-list');
      await randomDelay(1000, 2000);
    }

    // 7. Go to next page if available
    const nextLink = document.querySelector('.next-page a, a[rel="next"]');
    if (nextLink) {
      nextLink.click();
      await waitForElement('.topic-list');
    } else {
      isRunning = false; // No more pages
    }
  }
}
```

### 7. Similar Open-Source Browser Automation Extensions

| Project | Architecture | Relevance |
|---|---|---|
| **Tampermonkey / Violentmonkey** | Content script injection, `GM_*` APIs | Shows how to inject scripts into pages, handle SPA navigation |
| **Puppeteer** | CDP (Chrome DevTools Protocol) over WebSocket | Too heavy — requires launching Chrome programmatically, not suitable for extension |
| **Playwright** | Similar to Puppeteer, multi-browser | Same — external process, not extension-based |
| **Selenium WebDriver** | Browser driver + CDP/WebDriver protocol | Not extension-based |
| **Surfingkeys** | Chrome extension, content script | **Highly relevant** — vim-like browser control via content script, key mapping, scroll, click, navigate |
| **Vimium** | Chrome extension, content script | **Highly relevant** — link hinting, scroll, navigate, all via content script DOM APIs |
| **Linkclump** | Chrome extension, content script | Link selection and opening — shows content script click patterns |
| **Auto Scroll** (various) | Chrome extension | Simple auto-scroll implementations |
| **Distill Web Monitor** | Chrome extension, content script | DOM monitoring for changes — relevant for detecting page load |
| **Browserless** | Headless Chrome service | External, not extension-based |

**Most useful references:**
1. **Vimium** (github.com/philc/vimium) — mature Chrome extension for keyboard-driven navigation. Shows scroll, click, navigate patterns all from content script. MIT license.
2. **Surfingkeys** (github.com/brookhong/Surfingkeys) — similar to Vimium but more powerful. Shows advanced content script patterns. MIT license.
3. **Distill Web Monitor** — DOM mutation observation patterns for detecting page state changes.

### 8. Practical Patterns: Scroll + Click + Navigate in Content Script

**Complete content script skeleton:**

```javascript
// content.js — injected into linux.do
(() => {
  'use strict';

  let isRunning = false;
  let scrollTimer = null;

  // === Utilities ===
  function randomDelay(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  }

  // === Scrolling ===
  function autoScroll(options = {}) {
    const { minSpeed = 1, maxSpeed = 3, interval = 50, jitter = 0.3 } = options;
    return new Promise((resolve) => {
      let lastScrollY = -1;
      let stuckCount = 0;

      scrollTimer = setInterval(() => {
        if (!isRunning) {
          clearInterval(scrollTimer);
          return resolve('stopped');
        }

        const speed = minSpeed + Math.random() * (maxSpeed - minSpeed);
        const jitterOffset = (Math.random() - 0.5) * jitter * speed;
        window.scrollBy(0, speed + jitterOffset);

        // Check if stuck at bottom
        if (window.scrollY === lastScrollY) {
          stuckCount++;
          if (stuckCount > 20) { // ~1 second stuck
            clearInterval(scrollTimer);
            resolve('bottom');
          }
        } else {
          stuckCount = 0;
        }
        lastScrollY = window.scrollY;
      }, interval);
    });
  }

  // === Navigation Detection ===
  function waitForNavigation(timeout = 10000) {
    return new Promise((resolve) => {
      const startUrl = window.location.href;
      const check = setInterval(() => {
        if (window.location.href !== startUrl) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, timeout);
    });
  }

  function waitForContentReady(selector, timeout = 15000) {
    return waitForElement(selector, timeout).then(() => randomDelay(500, 1500));
  }

  // === Link Interception ===
  function interceptNewTabLinks() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[target="_blank"]');
      if (link && link.href.includes('linux.do')) {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = link.href;
      }
    }, true);
  }

  // === Topic Discovery ===
  function getTopicLinks() {
    // Discourse topic list selectors
    const selectors = [
      '.topic-list-item .title a:not(.badge-notification)',
      '.topic-list-item a.raw-topic-link',
      '#list-area .main-link a',
    ];
    for (const sel of selectors) {
      const links = [...document.querySelectorAll(sel)];
      if (links.length > 0) return links;
    }
    return [];
  }

  // === Main Browse Loop ===
  async function browseLoop() {
    interceptNewTabLinks();

    while (isRunning) {
      const topics = getTopicLinks();
      if (topics.length === 0) {
        await randomDelay(2000, 3000);
        continue;
      }

      for (const topicLink of topics) {
        if (!isRunning) break;

        // Click topic
        topicLink.click();

        // Wait for topic content to appear
        await waitForContentReady('.topic-body, #post_1, .cooked');

        // Simulate reading: slow scroll
        await autoScroll({ minSpeed: 0.5, maxSpeed: 2.5, interval: 60 });

        // Pause at bottom
        await randomDelay(2000, 5000);

        // Go back to list
        window.history.back();
        await waitForContentReady('.topic-list');
        await randomDelay(1000, 3000);
      }

      // Try next page
      const nextBtn = document.querySelector('.next-page a, a[rel="next"], .pagination .next a');
      if (nextBtn && isRunning) {
        nextBtn.click();
        await waitForContentReady('.topic-list');
        await randomDelay(1000, 2000);
      } else {
        isRunning = false;
      }
    }

    notifyBackground('browse-complete');
  }

  // === Messaging with Background/Popup ===
  function notifyBackground(type, data = {}) {
    chrome.runtime.sendMessage({ type, ...data });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start-browse') {
      isRunning = true;
      browseLoop();
      sendResponse({ status: 'started' });
    }
    if (msg.type === 'stop-browse') {
      isRunning = false;
      if (scrollTimer) clearInterval(scrollTimer);
      sendResponse({ status: 'stopped' });
    }
    if (msg.type === 'get-status') {
      sendResponse({ isRunning });
    }
  });
})();
```

### 9. Discourse-Specific Selectors (linux.do)

Based on standard Discourse templates:

| Element | Selector |
|---|---|
| Topic list items | `.topic-list-item` |
| Topic title link | `.topic-list-item .title a`, `.raw-topic-link` |
| Topic body / post content | `.topic-body`, `.cooked`, `#post_1` |
| Back to list (breadcrumb) | `.nav-item_0 a`, `#navigation-bar a:first-child` |
| Next page | `.next-page a`, `.pagination .next a` |
| Loading indicator | `.topic-list .spinner`, `#main-outlet .loading` |
| Post stream container | `#topic` |

**Note:** These selectors should be verified against the actual linux.do DOM. Discourse themes can customize the template.

### 10. Anti-Detection Considerations

To simulate human-like browsing:

| Technique | Implementation |
|---|---|
| Variable scroll speed | Random `scrollBy` distance per interval (0.5–3px per 50ms) |
| Random pauses | `randomDelay()` between actions (1–5 seconds) |
| Jitter in timing | Vary interval timing by ±20% |
| Occasional back-scroll | Small upward scroll (10–20px) then continue down |
| Variable read time | Longer pause for longer posts (proportional to scroll height) |
| Mouse movement | Not needed for forum browsing, but could add occasional `mousemove` events |
| Viewport simulation | `IntersectionObserver` to "read" visible content |

### 11. Open Questions from PRD Still Valid

From the PRD's open questions, these affect implementation:

1. **Browse goal** — affects which topic list to use (latest, unread, top, etc.)
2. **Scroll speed preference** — affects `autoScroll` parameters
3. **Category filtering** — could use Discourse API `/latest.json?category=...`
4. **Error handling** — network failures, page load timeouts, Discourse rate limits

## Caveats / Not Found

- **Kimi WebBridge extension source code** is not available locally (only the daemon binary and skill docs are present). The extension itself is closed-source, installed from Chrome Web Store.
- **Exact linux.do DOM structure** should be verified by inspecting the live site. Discourse versions and custom themes can change selectors.
- **Discourse rate limiting** — frequent rapid requests may trigger Discourse's built-in rate limiter. Need to test with realistic timing.
- **Manifest V3 service worker lifecycle** — service workers can be terminated after 30 seconds of inactivity. Long-running loops should be in the content script, not the background worker.
