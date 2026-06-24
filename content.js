(() => {
  'use strict';

  let isRunning = false;
  let scrollTimer = null;
  let currentTopicIndex = 0;
  let speedSetting = 2;
  let reloadCount = 0;
  const MAX_RELOADS = 50;

  const SPEED_CONFIG = {
    1: { minSpeed: 0.2, maxSpeed: 0.8, interval: 80 },
    2: { minSpeed: 0.5, maxSpeed: 2.5, interval: 60 },
    3: { minSpeed: 1.5, maxSpeed: 5.0, interval: 40 },
    4: { minSpeed: 4,   maxSpeed: 10,  interval: 30 },
    5: { minSpeed: 24,  maxSpeed: 56,  interval: 70 }
  };

  // === Utilities ===

  function log(...args) {
    console.log('[AutoBrowse]', ...args);
  }

  function saveState(running) {
    try {
      chrome.storage.local.set({
        contentIsRunning: running,
        contentTopicIndex: currentTopicIndex,
        contentReloadCount: reloadCount
      });
    } catch (e) {}
  }

  function clearState() {
    try {
      chrome.storage.local.set({
        contentIsRunning: false,
        contentTopicIndex: 0,
        contentReloadCount: 0
      });
    } catch (e) {}
  }

  function randomDelay(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        clearInterval(checker);
        resolve();
      }, ms);
      const checker = setInterval(() => {
        if (!isRunning) {
          clearTimeout(timer);
          clearInterval(checker);
          resolve();
        }
      }, 200);
    });
  }

  function waitForElement(selector, timeout = 20000) {
    log('Waiting for:', selector);
    const existing = document.querySelector(selector);
    if (existing && existing.textContent.trim().length > 0) {
      log('Found immediately:', selector);
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (!isRunning) {
          clearInterval(interval);
          return resolve(null);
        }
        const el = document.querySelector(selector);
        if (el && el.textContent.trim().length > 0) {
          clearInterval(interval);
          log('Found:', selector);
          resolve(el);
        } else if (Date.now() - start > timeout) {
          clearInterval(interval);
          if (el) {
            // Element exists but no content — try one more time
            log('Element found but empty, continuing anyway:', selector);
            resolve(el);
          } else {
            reject(new Error(`Timeout: ${selector}`));
          }
        }
      }, 300);
    });
  }

  // === Scrolling ===

  function autoScroll(options = {}) {
    const { minSpeed = 0.5, maxSpeed = 2.5, interval = 60 } = options;
    return new Promise((resolve) => {
      let lastScrollY = -1;
      let stuckCount = 0;

      scrollTimer = setInterval(() => {
        if (!isRunning) {
          clearInterval(scrollTimer);
          scrollTimer = null;
          return resolve('stopped');
        }

        const speed = minSpeed + Math.random() * (maxSpeed - minSpeed);
        const jitter = (Math.random() - 0.5) * 0.5;
        window.scrollBy(0, speed + jitter);

        if (Math.random() < 0.01) {
          setTimeout(() => {
            window.scrollBy(0, -(10 + Math.random() * 20));
          }, 100);
        }

        if (window.scrollY === lastScrollY) {
          stuckCount++;
          if (stuckCount > 30) {
            clearInterval(scrollTimer);
            scrollTimer = null;
            resolve('bottom');
          }
        } else {
          stuckCount = 0;
        }
        lastScrollY = window.scrollY;
      }, interval);
    });
  }

  // === Topic Discovery ===

  function getTopicLinks() {
    const selectors = [
      '.topic-list-item .title a:not(.badge-notification)',
      '.topic-list-item a.raw-topic-link',
      '#list-area .main-link a',
      '.topic-list-item a[data-topic-id]'
    ];
    for (const sel of selectors) {
      const links = [...document.querySelectorAll(sel)].filter(a => {
        const href = a.href;
        if (!href || !href.includes('/t/') || href.includes('#')) return false;
        const listItem = a.closest('.topic-list-item');
        if (listItem && listItem.classList.contains('pinned')) return false;
        return true;
      });
      if (links.length > 0) {
        log(`Found ${links.length} topics with: ${sel}`);
        return links;
      }
    }
    log('No topics found');
    return [];
  }

  function isTopicPage() {
    return /\/t\/[^/]+\/\d+/.test(window.location.pathname) ||
           /\/t\/topic\/\d+/.test(window.location.pathname);
  }

  function isTopicListPage() {
    const path = window.location.pathname;
    return path === '/latest' || path === '/latest/' ||
           path === '/' || path.startsWith('/c/') ||
           path === '/top' || path.startsWith('/top/');
  }

  // === Main Browse Loop ===
  //
  // DESIGN: Uses direct URL navigation (window.location.href) for reliability.
  // Each navigation causes a page reload. State is saved before each reload.
  // On reload, init code checks saved state and resumes the loop.
  //
  // Flow:
  // 1. On list page → get topic links → save index N → navigate to topic N URL
  // 2. Page reloads on topic page → init resumes → scroll topic → navigate to list
  // 3. Page reloads on list page → init resumes → get links → navigate to topic N+1
  // 4. Repeat until all topics done, then next page

  async function browseLoop() {
    log('browseLoop started, path:', window.location.pathname, 'index:', currentTopicIndex);

    try {
      // --- STEP 1: Ensure we're on a topic list page ---
      if (!isTopicListPage()) {
        log('Not on list page, navigating to /latest');
        window.location.href = 'https://linux.do/latest';
        return; // Page reloads; init resumes
      }

      // --- STEP 2: Get topic links ---
      const topics = getTopicLinks();
      log('Topics found:', topics.length);

      if (topics.length === 0) {
        notifyBackground('browse-status', { status: 'no-topics' });
        await randomDelay(5000, 8000);
        if (!isRunning) return;
        // Reload to try again
        saveState(true);
        window.location.href = 'https://linux.do/latest';
        return;
      }

      // --- STEP 3: Check if we've finished all topics on this page ---
      if (currentTopicIndex >= topics.length) {
        log('All topics on this page done, checking for next page');
        const nextBtn = document.querySelector('.next-page a, a[rel="next"], .pagination .next a');
        if (nextBtn) {
          log('Next page found, navigating');
          notifyBackground('browse-status', { status: 'next-page' });
          currentTopicIndex = 0;
          saveState(true);
          window.location.href = nextBtn.href;
          return; // Page reloads; init resumes
        } else {
          log('No more pages, complete');
          notifyBackground('browse-status', { status: 'complete' });
          isRunning = false;
          clearState();
          return;
        }
      }

      // --- STEP 4: Navigate to the current topic ---
      const topicLink = topics[currentTopicIndex];
      const topicUrl = topicLink.href;

      notifyBackground('browse-status', {
        status: 'browsing',
        total: topics.length,
        current: currentTopicIndex,
        title: topicLink.textContent.trim()
      });

      log('Navigating to topic', currentTopicIndex, ':', topicUrl);
      saveState(true);
      window.location.href = topicUrl;
      return; // Page reloads; init resumes on topic page

    } catch (err) {
      log('Fatal error:', err.message);
      notifyBackground('browse-status', {
        status: 'topic-error',
        error: '浏览循环异常: ' + err.message
      });
      isRunning = false;
      clearState();
      notifyBackground('browse-status', { status: 'stopped' });
    }
  }

  // Resume loop — called when we're on a topic page (after navigation)
  async function resumeOnTopicPage() {
    log('Resuming on topic page, scrolling:', window.location.href);

    notifyBackground('browse-status', {
      status: 'on-topic',
      current: currentTopicIndex,
      title: document.title
    });

    // Wait for content to load
    try {
      await waitForElement('.topic-body, #post_1, .cooked', 20000);
    } catch (e) {
      log('Topic content not found, skipping');
      currentTopicIndex++;
      saveState(true);
      window.location.href = 'https://linux.do/latest';
      return;
    }

    if (!isRunning) return;

    // Extra wait for content to fully render
    await randomDelay(1500, 3000);
    if (!isRunning) return;

    // Scroll to top
    scrollTo(0, 0);
    await randomDelay(1000, 2000);
    if (!isRunning) return;

    // Slow scroll through the topic
    log('Starting auto-scroll');
    const speedCfg = SPEED_CONFIG[speedSetting] || SPEED_CONFIG[2];
    await autoScroll(speedCfg);
    log('Auto-scroll done');

    if (!isRunning) return;

    // Pause at bottom
    await randomDelay(2000, 5000);
    if (!isRunning) return;

    // Move to next topic and go back to list
    currentTopicIndex++;
    log('Done with topic, going to next. Index:', currentTopicIndex);
    saveState(true);
    window.location.href = 'https://linux.do/latest';
    return; // Page reloads; init resumes on list page
  }

  // === Messaging ===

  function notifyBackground(type, data = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start-browse') {
      log('Received start-browse');
      if (!isRunning) {
        isRunning = true;
        currentTopicIndex = 0;
        reloadCount = 0;
        saveState(true);
        notifyBackground('browse-status', { status: 'starting' });
        browseLoop();
      }
      sendResponse({ status: 'started' });
    }
    if (msg.type === 'stop-browse') {
      log('Received stop-browse');
      isRunning = false;
      if (scrollTimer) {
        clearInterval(scrollTimer);
        scrollTimer = null;
      }
      clearState();
      sendResponse({ status: 'stopped' });
    }
    if (msg.type === 'get-status') {
      sendResponse({ isRunning });
    }
    if (msg.type === 'set-speed') {
      speedSetting = msg.speed;
      sendResponse({ status: 'ok' });
    }
  });

  // === Init: Restore state and resume after page reload ===
  log('Content script loaded, path:', window.location.pathname);

  try {
    chrome.storage.local.get(
      ['speedSetting', 'contentIsRunning', 'contentTopicIndex', 'contentReloadCount'],
      (result) => {
        log('Storage state:', result);
        if (result.speedSetting) speedSetting = result.speedSetting;
        reloadCount = (result.contentReloadCount || 0) + 1;

        if (result.contentIsRunning) {
          if (reloadCount > MAX_RELOADS) {
            log('Max reloads reached, stopping');
            clearState();
            notifyBackground('browse-status', { status: 'stopped', error: '达到最大刷新次数限制' });
            return;
          }

          isRunning = true;
          currentTopicIndex = result.contentTopicIndex || 0;
          log('Resuming, index:', currentTopicIndex, 'reload:', reloadCount);

          if (isTopicPage()) {
            // We're on a topic page — scroll it, then go to next
            resumeOnTopicPage();
          } else {
            // We're on the list page — browse to the next topic
            browseLoop();
          }
        }
      }
    );
  } catch (e) {
    log('Init error:', e.message);
  }
})();
