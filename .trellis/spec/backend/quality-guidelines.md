# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Scenario: MV3 CDP Automation Controller

### 1. Scope / Trigger
- Trigger: Browser-extension background automation that uses `chrome.debugger` / Chrome DevTools Protocol and reports state to the popup through `chrome.storage.local`.
- Applies when changing `background.js`, extension permissions, popup runtime messages, or storage keys that represent automation state.

### 2. Signatures
- Runtime messages handled by `background.js`:
  - `{ type: 'start-browse' } -> { status: 'started' | 'already-running' } | { error: string }`
  - `{ type: 'stop-browse' } -> { status: 'stopped' | 'not-running' }`
  - `{ type: 'focus-browse-tab' } -> { status: 'focused' | 'not-running' | 'not-found' }`
  - `{ type: 'get-background-status' } -> { isRunning: boolean, status: string, data: object, browseTabId: number | null }`
  - `{ type: 'set-speed', speed: number } -> { status: 'ok' }`
- Manifest requirements:
  - `permissions` must include `"debugger"`, `"tabs"`, `"tabGroups"`, and `"storage"`.
  - `minimum_chrome_version` should remain `118` or newer while long-running CDP sessions depend on debugger keeping the MV3 service worker alive.

### 3. Contracts
- `background.js` is the source of truth for CDP automation state.
- `popup.js` must read current state through `get-background-status` and live updates through `chrome.storage.local`.
- Storage fields written by background:
  - `browseStatus`: one of `starting`, `browsing`, `on-topic`, `next-page`, `topic-error`, `no-topics`, `complete`, `stopped`.
  - `browseData`: `{ total?: number, current?: number, title?: string, error?: string }`.
  - `browseTabId`: automation tab id while running; `null` after `complete` or `stopped`.
  - `cdpIsRunning`: true only while CDP automation is active.
  - `contentIsRunning`: must be false for CDP mode to prevent legacy content-script resume.
  - `automationMode`: `"cdp"`.

### 4. Validation & Error Matrix
- No existing LinuxDo tab -> create `https://linux.do/latest`, group it, then attach CDP.
- `chrome.debugger.attach` fails -> stop, clear running flags, and surface startup error.
- `chrome.debugger.onDetach` fires unexpectedly -> stop and surface a clear stopped/error status.
- Automation tab closes -> stop and clear `browseTabId`.
- Automation tab navigates outside `https://linux.do/*` -> stop.
- Automation tab manually navigates away from the expected LinuxDo flow during a run -> stop.
- Same-topic Discourse URL changes, such as adding a post-number segment, are not manual navigation and must not stop automation.
- Login/signup page detected -> stop with a login-required message.
- Repeated empty topic list -> retry a small bounded number of times, then stop.

### 5. Good/Base/Bad Cases
- Good: User clicks start with no LinuxDo tab; extension creates a grouped `/latest` tab, attaches CDP, and popup shows running progress.
- Base: User clicks start with an existing LinuxDo tab; extension reuses and groups that tab.
- Bad: User opens DevTools for the automation tab; debugger detaches, and the popup must not keep showing stale running state.
- Bad: Same-topic scroll updates the URL from `/t/slug/123` to `/t/slug/123/2`; this must continue, not stop as manual navigation.

### 6. Tests Required
- Syntax-check changed JavaScript with `node --check`.
- Validate `manifest.json` with `python3 -m json.tool`.
- Search for stale legacy paths such as `contentIsRunning`, `chrome.tabs.sendMessage`, `chrome.scripting`, `content_scripts`, and confirm they are not part of the active automation path.
- Manual extension QA should cover start, stop, no-existing-tab startup, focus/view, tab close, debugger detach, and manual navigation interruption.
- For inactive-tab scrolling, prefer `Runtime.evaluate` with `window.scrollBy()` over `Input.dispatchMouseEvent(mouseWheel)`, because CDP input events model foreground user input and may not advance an inactive tab.

### 7. Wrong vs Correct

#### Wrong
```javascript
chrome.storage.local.set({ contentIsRunning: true });
chrome.tabs.sendMessage(tabId, { type: 'start-browse' });
```

This revives the legacy content-script timer loop and can conflict with CDP automation.

#### Correct
```javascript
chrome.storage.local.set({
  cdpIsRunning: true,
  contentIsRunning: false,
  automationMode: 'cdp'
});
chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
```

The background controller owns navigation, DOM inspection, scroll input, and cleanup.

For scrolling an inactive automation tab, the controller should execute a page scroll command:

```javascript
chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
  expression: 'window.scrollBy(0, 100); window.scrollY',
  returnByValue: true
});
```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
