# fix: CDP automation inactive tab behavior

## Goal

Fix the CDP-based LinuxDo automation so it continues reading while the user works in other browser tabs, and so focusing/clicking back into the automation tab does not stop the run. Automation should stop only for explicit stop, tab close, debugger detach, login failure, or a real navigation outside the expected automation flow.

## What I Already Know

* User observed two regressions after the CDP implementation:
  * Switching to another tab stops effective post scrolling/reading.
  * Clicking back into the automation tab causes automation to stop.
* The current `background.js` uses `Input.dispatchMouseEvent` with `type: 'mouseWheel'` to scroll.
* CDP input events are a poor fit for an inactive/background tab because they model user input into a visible target.
* The current `ensureExpectedLocation()` compares normalized URLs by exact path.
* LinuxDo is Discourse-based; topic URLs can change while reading, for example adding a post number segment under the same topic. Exact-path comparison can mistake normal in-topic route updates for manual navigation.
* Previous product decision remains: one grouped LinuxDo automation tab; no visible dedicated automation window.
* Previous updated spec says `background.js` is the CDP source of truth and `contentIsRunning` must stay false.

## Requirements

* Continue automation when the user switches to other tabs.
* Focusing/clicking the automation tab must not stop automation.
* Replace inactive-tab-sensitive wheel input with a CDP/background-owned scroll operation that works without the automation tab being active.
* Treat normal same-topic URL changes as valid during topic reading.
* Still stop on explicit popup stop, automation tab close, unexpected debugger detach, leaving `https://linux.do/*`, login/signup page, or real unexpected navigation to another LinuxDo page outside the current flow.
* Preserve popup status and speed controls.

## Acceptance Criteria

* [ ] Starting automation and switching to another browser tab still advances post scrolling/reading.
* [ ] Clicking/focusing the automation tab during a run does not stop automation.
* [ ] Same-topic URL changes such as adding a post-number segment do not trigger "自动化标签被手动导航".
* [ ] Manual navigation to an unrelated LinuxDo page during a run still stops with a clear message.
* [ ] Explicit stop still stops and clears running state.
* [ ] Syntax and manifest checks pass.

## Definition of Done

* Tests/checks run where practical.
* Docs/spec updated if behavior contract changes.
* Existing unrelated `icons/*.png` changes are left untouched.

## Technical Approach

* Replace CDP wheel dispatch with `Runtime.evaluate`-driven `window.scrollBy()` calls from the background loop. This keeps timing in the service worker and does not rely on page timers or active-tab input dispatch.
* Add URL classification helpers:
  * LinuxDo origin check remains strict.
  * Topic comparison should allow the same topic id even if the post-number segment changes.
  * List-page comparison should allow the expected list route while preventing unrelated manual navigation.
* Narrow "manual interference" to true navigation away from the expected flow, not simple focus/activation.

## Out of Scope

* Reintroducing content-script timer automation.
* Opening a separate visible automation window.
* Supporting completely hidden first-party pages outside Chrome extension constraints.

## Technical Notes

* Task created at `.trellis/tasks/06-23-fix-cdp-inactive-tab-behavior`.
* Relevant files inspected: `background.js`, `popup.js`, `.trellis/spec/backend/quality-guidelines.md`.
* Existing dirty files before this task: `icons/icon128.png`, `icons/icon16.png`, `icons/icon48.png`; do not include them in this task.
