# brainstorm: background reading automation

## Goal

Make the extension's simulated post-reading/scrolling workflow run without forcing the user to keep the target browser tab active, so the automation can continue while the user uses the browser normally for other work.

## What I already know

* The current behavior appears to require the target tab to stay active for simulated user scrolling/reading to work.
* The desired behavior is similar in spirit to kimi-webbridge: the automation should do its own work without monopolizing the visible browser tab.
* The user explicitly considers the current "keep the tab active" requirement unacceptable and wants to keep using Chrome normally while automation continues.
* This is a browser extension project for LinuxDo auto browsing.
* The project is a small Chrome MV3 extension with `manifest.json`, `background.js`, `content.js`, `popup.js`, and static popup assets.
* `background.js` finds an existing `https://linux.do/*` tab, groups it, injects/contacts `content.js`, and stores status in `chrome.storage.local`.
* `content.js` implements the main browsing loop in the page itself. It navigates via `window.location.href`, resumes from `chrome.storage.local`, waits for topic DOM, and scrolls with `setInterval` plus `window.scrollBy`.
* `popup.js` only controls start/stop/view/status and delegates execution to the background/content scripts.
* `README.md` currently documents "single tab, no new tabs" behavior, which conflicts with a dedicated automation-surface approach.
* Official Chrome docs confirm a tab can be active in its own window without that window being focused, which supports a dedicated automation window that does not take over the user's main browser window.
* Official Chrome timer-throttling docs confirm hidden pages, different active tabs, or minimized windows can throttle `setTimeout`/`setInterval`, which matches the observed current failure mode.

## Assumptions (temporary)

* The current implementation drives scrolling from code that depends on page timers and page visibility.
* The desired MVP should preserve existing reading behavior and progress accounting while changing how the work runs.
* Browser extension platform constraints limit what can be done in inactive/background tabs, so the final implementation likely needs a dedicated automation window or a CDP/debugger-based model rather than just "scroll inactive tab".

## Open Questions

* None.

## Requirements (evolving)

* Automation should not require the user to keep the target LinuxDo tab selected in the foreground.
* The user should be able to keep using the browser for unrelated browsing while automated reading continues.
* MVP should target `chrome.debugger` / CDP automation rather than a dedicated visible automation window.
* The automation surface should follow the current model: operate one LinuxDo tab inside the existing "LinuxDo 刷帖" tab group.
* Start should prefer an existing `https://linux.do/*` tab, but if none exists it should automatically create a new `https://linux.do/latest` tab and put it into the "LinuxDo 刷帖" group.
* Core reading/scrolling should be driven from the background service worker through CDP commands, not by relying on hidden page `setInterval` timers.
* Existing simulated reading semantics should be preserved unless we explicitly decide otherwise.
* The solution should keep start/stop/status UX in the popup.
* The solution should handle the automation tab/window being closed by stopping cleanly.
* The solution should handle `chrome.debugger.onDetach` by stopping cleanly and surfacing an actionable status/error.
* During automation, the grouped LinuxDo tab should be treated as automation-owned. If the user closes it, debugger attachment is lost, or it navigates unexpectedly outside the expected LinuxDo reading flow, automation should stop and report the issue instead of trying to fight the user's action.

## Acceptance Criteria (evolving)

* [ ] Starting automated post reading no longer requires the user to keep the target tab active.
* [ ] If no LinuxDo tab exists, starting automation creates a `https://linux.do/latest` tab and groups it under "LinuxDo 刷帖".
* [ ] User interaction with other browser tabs does not pause or break the automated reading workflow.
* [ ] The automation loop can navigate, inspect topic content, and scroll/read via CDP commands owned by the background service worker.
* [ ] Existing completion/progress behavior remains correct.
* [ ] Closing the automation surface updates extension status to stopped instead of leaving stale running state.
* [ ] Losing debugger attachment updates extension status to stopped/error instead of leaving stale running state.
* [ ] Manual interference with the automation tab stops the run and shows a clear popup status/error.
* [ ] The popup still provides a way to view/focus the automation surface.

## Definition of Done (team quality bar)

* Tests added/updated where practical for the changed automation flow.
* Lint / typecheck / build are green.
* Docs/notes updated if user-visible behavior or permissions change.
* Rollout/rollback considered if the implementation touches extension permissions or browser automation APIs.

## Out of Scope (explicit)

* Rewriting the full extension architecture unless code inspection shows it is required.
* Changing the definition of a "read" or bypassing site behavior in a way that materially differs from the current simulated-reading feature.
* Supporting non-Chromium browsers unless the project already targets them.
* Fully invisible external browser automation like a separate native daemon unless explicitly selected later.
* Fighting user actions by repeatedly reclaiming or renavigating a tab after the user manually changes it during automation.

## Research References

* [`research/background-tab-automation.md`](research/background-tab-automation.md) — Chrome background tabs throttle chained timers, offscreen documents are not a drop-in first-party tab replacement, and a dedicated automation window is the lowest-risk MVP.
* [`research/debugger-cdp-background-automation.md`](research/debugger-cdp-background-automation.md) — `chrome.debugger` can drive navigation, DOM inspection, and scroll input through CDP, but requires the sensitive `"debugger"` permission and detach handling.

## Research Notes

### Constraints from Chrome and the current repo

* The current `setInterval`-based scroll loop is vulnerable to hidden-page timer throttling.
* A normal/popup automation window can host a real logged-in LinuxDo tab and keep the current content-script architecture mostly intact.
* A minimized or inactive tab remains risky because it may be treated as hidden and throttled.
* A debugger/CDP model is technically stronger but requires the sensitive `"debugger"` permission and a larger implementation.
* An offscreen document is hidden and extension-owned, but cannot directly become a first-party LinuxDo tab.

### Feasible approaches here

**Approach A: Dedicated Automation Window** (Recommended)

* How it works: create or reuse an extension-managed LinuxDo window/tab for automation, keep that tab active in its own window, and return focus to the user's prior window.
* Pros: avoids `"debugger"` permission, fits the existing content-script loop, and lets the user keep using their normal browser window.
* Cons: the automation surface is a real visible window; minimizing it may reintroduce throttling risk.

**Approach B: Debugger/CDP-Driven Automation**

* How it works: attach `chrome.debugger` to an automation tab and drive navigation/scroll/input from the background via DevTools Protocol commands.
* Pros: less dependent on page timers and closer to browser automation tools.
* Cons: sensitive permission, larger rewrite, more QA surface, possible conflicts with DevTools/debug sessions.
* Status: selected by user for MVP because the automation should be as invisible as practical.

**Approach C: Offscreen Document**

* How it works: move work into an extension offscreen document and attempt iframe/scraping-based processing.
* Pros: potentially no visible automation tab/window.
* Cons: weak fit for logged-in first-party site behavior, CSP/frame/cookie risks, and not aligned with the current content-script design.

## Technical Notes

* Task created at `.trellis/tasks/06-22-background-reading-automation`.
* Repo status at task creation only showed this new task directory as uncommitted.
* Project specs are single-repo with `backend` and `frontend` layers.
* Relevant files inspected: `manifest.json`, `background.js`, `content.js`, `popup.js`, `README.md`.
* Relevant specs/guides inspected: `.trellis/spec/backend/index.md`, `.trellis/spec/frontend/index.md`, `.trellis/spec/guides/index.md`, `.trellis/spec/guides/cross-layer-thinking-guide.md`, `.trellis/spec/guides/code-reuse-thinking-guide.md`.
* Chrome docs verified on 2026-06-23: `chrome.tabs.Tab.active` is per-window and does not necessarily mean the window is focused; `chrome.windows.create({ focused: false })` can open an inactive window; hidden/minimized pages throttle chained timers; `chrome.debugger` requires the `"debugger"` permission and can send CDP commands; offscreen documents are hidden extension pages, not first-party site tabs.
* CDP docs verified on 2026-06-23: `Page.navigate` can drive page navigation; `Runtime.evaluate` can inspect page DOM/state; `Input.dispatchMouseEvent` and `Input.synthesizeScrollGesture` can simulate scroll input; `chrome.debugger.onDetach` must be handled for tab close or DevTools conflicts.
* Chrome service worker lifecycle docs verified on 2026-06-23: active `chrome.debugger` sessions keep extension service workers alive starting in Chrome 118; long-running CDP automation should therefore either set `minimum_chrome_version` to 118+ or include a fallback for older Chrome.

## Decision (ADR-lite)

**Context**: The current content-script loop depends on page timers and a visible/active tab, which conflicts with the requirement that automation should keep running while the user uses Chrome normally.

**Decision**: Use `chrome.debugger` / CDP for the MVP instead of a dedicated visible automation window. The background service worker will own the automation loop and drive navigation, DOM inspection, and scroll simulation through CDP.

**Consequences**: The extension must request the sensitive `"debugger"` permission, handle debugger detach as a normal failure path, and likely rewrite a meaningful part of `background.js`/`content.js` coordination. This gets closer to the user's "do its own work" requirement but still cannot create a truly hidden first-party LinuxDo tab through normal Chrome extension APIs.

## Product Decision: Automation Surface

**Context**: The current extension already finds a LinuxDo tab, groups it under "LinuxDo 刷帖", and runs one-tab automation. The user wants to preserve that product model rather than adding a separate window or a different visible surface.

**Decision**: Keep one grouped LinuxDo tab as the automation surface. CDP should attach to that grouped tab and control it from the background service worker.

**Consequences**: The tab still exists visibly in Chrome and can be focused via popup, but the user should not need to keep it active. If the user manually uses/navigates that grouped tab during automation, the automation may be interrupted and should stop or recover explicitly.

## Product Decision: Startup Tab Policy

**Context**: The current extension requires an existing LinuxDo tab. The user wants to preserve the grouped one-tab model but selected automatic tab creation when none exists.

**Decision**: On start, reuse an existing LinuxDo tab if present. If none exists, create `https://linux.do/latest`, group it under "LinuxDo 刷帖", and attach CDP automation to that tab.

**Consequences**: Startup becomes smoother and no longer requires the user to manually open LinuxDo first. The implementation must still handle unauthenticated/login pages by stopping with a clear popup status rather than looping indefinitely.

## Product Decision: Manual Interference

**Context**: The automation tab remains visible and grouped in the browser, so the user can still click it, close it, open DevTools, or navigate it.

**Decision**: Treat the grouped LinuxDo tab as automation-owned while a run is active. If the user closes it, debugger attachment is lost, or the tab navigates outside the expected LinuxDo reading flow, stop automation and show a clear popup status/error.

**Consequences**: This avoids the extension fighting the user or silently corrupting progress. The trade-off is that manual interaction with the automation tab ends the current run instead of trying to recover automatically.
