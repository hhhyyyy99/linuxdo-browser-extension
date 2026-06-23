# Background Tab Automation Research

## Topic

How can a Chrome MV3 extension continue simulated LinuxDo post reading while the user uses the browser normally?

## Sources

* Chrome Extensions `chrome.tabs` API: https://developer.chrome.com/docs/extensions/reference/api/tabs
* Chrome Extensions `chrome.windows` API: https://developer.chrome.com/docs/extensions/reference/api/windows
* Chrome Extensions `chrome.debugger` API: https://developer.chrome.com/docs/extensions/reference/api/debugger
* Chrome Extensions `chrome.offscreen` API: https://developer.chrome.com/docs/extensions/reference/api/offscreen
* Chrome Developers timer throttling note: https://developer.chrome.com/blog/timer-throttling-in-chrome-88/
* Chrome DevTools Protocol `Input` domain: https://chromedevtools.github.io/devtools-protocol/tot/Input/

## Findings

* The current extension drives reading from `content.js` using `setInterval` and `window.scrollBy` inside the page. Chrome throttles timers for hidden pages: hidden pages can be checked once per second, and after more than five minutes of hidden chained timers can be checked only once per minute. This makes inactive-tab scrolling unreliable for a "normal reading" simulation.
* `chrome.tabs.create({ active: false })` can create an inactive tab, and `chrome.tabs.update({ active: true })` can make a tab active within its window without necessarily focusing that window. This supports a model where automation has its own active tab in a separate window while the user keeps focus elsewhere.
* `chrome.windows.create({ focused: false })` can open an inactive browser window. A dedicated normal or popup window can host the automation tab and keep it active in that window. A minimized window is risky because minimized pages may become hidden/throttled.
* `chrome.offscreen` creates a hidden extension-owned document. It is useful for DOM work in an extension page, but its URL must be a static bundled extension HTML file and it cannot be focused. It can use only `chrome.runtime` among extension APIs. It is not a drop-in replacement for a logged-in, first-party LinuxDo browsing tab.
* `chrome.debugger` can attach to tabs and send Chrome DevTools Protocol commands, including DOM mutation, runtime evaluation, and input events. The CDP `Input` domain can dispatch mouse wheel events and synthesize scroll gestures. This is powerful enough to drive a tab without relying on the page's own timers, but it requires the sensitive `"debugger"` permission and changes the trust/permission profile of the extension.

## Feasible Approaches

### Approach A: Dedicated Automation Window (recommended MVP)

Create or reuse a separate extension-managed LinuxDo window/tab for automation. Keep the automation tab active in that window and return focus to the user's previous window. Preserve the current content-script reading loop with minimal changes, plus state tracking for the automation window/tab.

Pros:
* Avoids adding the sensitive `debugger` permission.
* Closest to the existing architecture and easiest to implement safely.
* Lets the user continue using their normal browser window.

Cons:
* Creates a visible extra browser window.
* If the window is minimized or the automation tab stops being active in that window, throttling may still affect the simulation.
* Not as isolated as a separate browser profile or external automation daemon.

### Approach B: Debugger/CDP-Driven Automation

Add `"debugger"` permission, attach to an automation tab, and drive navigation/scrolling from the background service worker via CDP commands such as `Runtime.evaluate`, `Page.navigate`, and `Input.dispatchMouseEvent`.

Pros:
* Can avoid relying on content-script chained timers.
* Closer to browser automation tools.
* Potentially more robust when the tab is not foregrounded.

Cons:
* Requires a sensitive permission that users will notice and may not trust.
* Higher implementation and QA complexity.
* DevTools attachment can be interrupted by other debugging sessions.

### Approach C: Offscreen Document with Embedded/Scraped Content

Use an extension offscreen document to host an iframe or DOM scraping logic and move automation out of a visible tab.

Pros:
* No visible automation tab/window if it works.
* Built for background DOM tasks in MV3.

Cons:
* Offscreen documents must be extension pages, not arbitrary first-party LinuxDo tabs.
* Login, cookies, CSP, frame restrictions, and site behavior may prevent faithful reading simulation.
* Least aligned with current content-script architecture.

## Recommendation

Use Approach A for the MVP unless the product requirement is "no visible automation window at all." It addresses the user's core complaint, avoids a high-risk permission jump, and keeps implementation close to the current extension. Treat Approach B as a future robustness upgrade if the dedicated window still proves too visible or too throttle-prone.
