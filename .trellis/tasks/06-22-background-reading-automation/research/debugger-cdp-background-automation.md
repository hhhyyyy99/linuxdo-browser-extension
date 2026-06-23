# Debugger CDP Background Automation Research

## Topic

How should the extension implement a less-visible LinuxDo reading workflow using `chrome.debugger` and Chrome DevTools Protocol?

## Sources

* Chrome Extensions `chrome.debugger` API: https://developer.chrome.com/docs/extensions/reference/api/debugger
* Chrome DevTools Protocol `Input` domain: https://chromedevtools.github.io/devtools-protocol/tot/Input/
* Chrome DevTools Protocol `Page` domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/
* Chrome DevTools Protocol `Runtime` domain: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/

## Findings

* `chrome.debugger` requires the `"debugger"` manifest permission and attaches to a target tab with `chrome.debugger.attach({ tabId }, "1.3" | "0.1")`.
* Once attached, the service worker can send CDP commands via `chrome.debugger.sendCommand`.
* Useful CDP domains for this task are explicitly available through `chrome.debugger`: `Page`, `Runtime`, and `Input`.
* `Page.navigate` can drive URL changes without asking the content script to assign `window.location.href`.
* `Runtime.evaluate` can read page state, query topic links, inspect scroll positions, and return JSON results from the inspected page.
* `Input.dispatchMouseEvent` supports `mouseWheel` with `deltaY`; `Input.synthesizeScrollGesture` can synthesize longer scroll gestures with speed and repeat settings.
* `chrome.debugger.onDetach` fires when the target closes or a user action cancels the debugging session, including opening Chrome DevTools for the attached tab. The extension must treat detach as a first-class stop/error path.

## Recommended Shape

For the MVP, keep one extension-managed LinuxDo tab in the normal browser profile, but stop depending on content-script timers for the core reading loop.

* Background service worker owns the session state: current topic index, current page URL, status, and stop flag.
* Attach debugger to the automation tab on start.
* Navigate to `/latest` via `Page.navigate`.
* Use `Runtime.evaluate` to discover topic links and detect content readiness.
* Simulate reading with repeated CDP wheel/scroll commands from the service worker rather than page `setInterval`.
* Return progress/status through existing `chrome.storage.local` keys so popup UX stays mostly intact.
* Set the automation tab `autoDiscardable: false` where supported to reduce Chrome unloading the tab.
* Detach debugger and clear state on stop, completion, tab close, or `onDetach`.

## Risks

* The `"debugger"` permission is more sensitive than the current permission set and will be visible to users.
* CDP attachment conflicts with opening DevTools on the automation tab.
* A truly invisible first-party tab is not a normal Chrome extension primitive; the least-visible practical MVP is an extension-managed inactive tab, not a hidden tab.
* If Chrome freezes or discards the tab, CDP commands may fail; the MVP should detect failure and stop cleanly rather than leave stale running state.
