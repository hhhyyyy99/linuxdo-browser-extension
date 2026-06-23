// Background service worker - owns CDP-driven browsing automation.

const LINUXDO_LATEST_URL = 'https://linux.do/latest';
const GROUP_TITLE = 'LinuxDo 刷帖';
const GROUP_COLOR = 'cyan';
const CDP_PROTOCOL_VERSION = '1.3';
const MAX_NO_TOPIC_RETRIES = 3;

const SPEED_CONFIG = {
  1: { minSpeed: 0.2, maxSpeed: 0.8, interval: 80 },
  2: { minSpeed: 0.5, maxSpeed: 2.5, interval: 60 },
  3: { minSpeed: 1.5, maxSpeed: 5.0, interval: 40 },
  4: { minSpeed: 4, maxSpeed: 10, interval: 30 },
  5: { minSpeed: 8, maxSpeed: 20, interval: 20 }
};

const session = createEmptySession();
let stoppingPromise = null;

function createEmptySession() {
  return {
    isRunning: false,
    stopRequested: false,
    tabId: null,
    debuggerAttached: false,
    expectedDetach: false,
    currentListUrl: LINUXDO_LATEST_URL,
    currentTopicIndex: 0,
    noTopicRetries: 0,
    speedSetting: 2
  };
}

function resetSession() {
  const speedSetting = session.speedSetting || 2;
  Object.assign(session, createEmptySession(), { speedSetting });
}

function chromeAsync(action) {
  return new Promise((resolve, reject) => {
    action((result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
      } else {
        resolve(result);
      }
    });
  });
}

function storageGet(keys) {
  return chromeAsync((done) => chrome.storage.local.get(keys, done));
}

function storageSet(values) {
  return chromeAsync((done) => chrome.storage.local.set(values, done));
}

function tabQuery(query) {
  return chromeAsync((done) => chrome.tabs.query(query, done));
}

function tabCreate(createProperties) {
  return chromeAsync((done) => chrome.tabs.create(createProperties, done));
}

function tabGet(tabId) {
  return chromeAsync((done) => chrome.tabs.get(tabId, done));
}

function tabUpdate(tabId, updateProperties) {
  return chromeAsync((done) => chrome.tabs.update(tabId, updateProperties, done));
}

function windowUpdate(windowId, updateInfo) {
  return chromeAsync((done) => chrome.windows.update(windowId, updateInfo, done));
}

function attachDebugger(tabId) {
  return chromeAsync((done) => {
    chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION, done);
  });
}

function detachDebugger(tabId) {
  return chromeAsync((done) => {
    chrome.debugger.detach({ tabId }, done);
  });
}

function sendCdpCommand(method, params = {}) {
  ensureRunning();
  return chromeAsync((done) => {
    chrome.debugger.sendCommand({ tabId: session.tabId }, method, params, done);
  });
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

class StopRequested extends Error {
  constructor() {
    super('Automation stopped');
    this.name = 'StopRequested';
  }
}

function ensureRunning() {
  if (!session.isRunning || session.stopRequested || !session.tabId) {
    throw new StopRequested();
  }
}

function isLinuxDoUrl(url) {
  try {
    return new URL(url).origin === 'https://linux.do';
  } catch {
    return false;
  }
}

function normalizePageUrl(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  return `${parsed.origin}${pathname}`;
}

function samePageUrl(a, b) {
  try {
    return normalizePageUrl(a) === normalizePageUrl(b);
  } catch {
    return false;
  }
}

function getLinuxDoPath(url) {
  try {
    return new URL(url).pathname.replace(/\/$/, '') || '/';
  } catch {
    return '';
  }
}

function getTopicId(url) {
  const match = getLinuxDoPath(url).match(/\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?$/);
  return match ? match[1] : null;
}

function isSameTopicPage(actualUrl, expectedUrl) {
  const actualTopicId = getTopicId(actualUrl);
  const expectedTopicId = getTopicId(expectedUrl);
  return Boolean(actualTopicId && expectedTopicId && actualTopicId === expectedTopicId);
}

function isLoginLikeUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.startsWith('/login') || path.startsWith('/signup');
  } catch {
    return false;
  }
}

function readableDetachReason(reason) {
  if (reason === 'target_closed') return '自动化标签已关闭';
  if (reason === 'canceled_by_user') {
    return '调试连接已断开，可能是打开了 DevTools 或浏览器取消了连接';
  }
  return `调试连接已断开：${reason || '未知原因'}`;
}

async function updateStatus(status, data = {}) {
  const finalState = status === 'complete' || status === 'stopped';
  await storageSet({
    browseStatus: status,
    browseData: data,
    browseTabId: finalState ? null : session.tabId,
    cdpIsRunning: !finalState && session.isRunning,
    contentIsRunning: false,
    automationMode: 'cdp',
    lastUpdate: Date.now()
  });
}

async function startBrowse() {
  if (session.isRunning) {
    return { status: 'already-running' };
  }

  if (stoppingPromise) {
    await stoppingPromise;
  }

  const saved = await storageGet(['speedSetting']).catch(() => ({}));
  session.speedSetting = Number(saved.speedSetting) || 2;
  session.stopRequested = false;
  session.currentListUrl = LINUXDO_LATEST_URL;
  session.currentTopicIndex = 0;
  session.noTopicRetries = 0;

  try {
    await storageSet({
      browseStatus: 'starting',
      browseData: {},
      browseTabId: null,
      cdpIsRunning: false,
      contentIsRunning: false,
      automationMode: 'cdp',
      lastUpdate: Date.now()
    });

    const tab = await findOrCreateLinuxDoTab();
    session.tabId = tab.id;
    session.isRunning = true;

    await storageSet({ browseTabId: tab.id });
    await groupBrowseTab(tab.id);
    await keepTabFromDiscarding(tab.id);

    await attachDebugger(tab.id);
    session.debuggerAttached = true;
    await sendCdpCommand('Page.enable');
    await sendCdpCommand('Runtime.enable');
    await updateStatus('starting');

    runBrowseSession().catch((err) => {
      if (err instanceof StopRequested) return;
      stopSession({ error: err.message || '自动浏览失败' });
    });

    return { status: 'started' };
  } catch (err) {
    const message = err.message || '启动失败';
    await stopSession({ error: `启动失败：${message}` });
    return { error: message };
  }
}

async function stopBrowse() {
  if (!session.isRunning && !session.tabId) {
    await storageSet({
      browseStatus: 'stopped',
      browseData: {},
      browseTabId: null,
      cdpIsRunning: false,
      contentIsRunning: false,
      automationMode: 'cdp',
      lastUpdate: Date.now()
    });
    return { status: 'not-running' };
  }

  await stopSession();
  return { status: 'stopped' };
}

async function getBackgroundStatus() {
  const stored = await storageGet(['browseStatus', 'browseData', 'browseTabId', 'cdpIsRunning'])
    .catch(() => ({}));

  return {
    isRunning: session.isRunning,
    status: session.isRunning ? (stored.browseStatus || 'starting') : (stored.browseStatus || 'stopped'),
    data: stored.browseData || {},
    browseTabId: session.tabId || stored.browseTabId || null
  };
}

async function setSpeed(speed) {
  session.speedSetting = Number(speed) || 2;
  await storageSet({ speedSetting: session.speedSetting });
  return { status: 'ok' };
}

async function focusBrowseTab() {
  const tabId = session.tabId || (await storageGet(['browseTabId']).catch(() => ({}))).browseTabId;
  if (!tabId) return { status: 'not-running' };

  try {
    const tab = await tabGet(tabId);
    await windowUpdate(tab.windowId, { focused: true });
    await tabUpdate(tabId, { active: true });
    return { status: 'focused' };
  } catch {
    return { status: 'not-found' };
  }
}

async function findOrCreateLinuxDoTab() {
  const tabs = await tabQuery({ url: 'https://linux.do/*' });
  const active = tabs.find((tab) => tab.active);
  if (active) return active;
  if (tabs.length > 0) return tabs[0];
  return tabCreate({ url: LINUXDO_LATEST_URL, active: false });
}

async function groupBrowseTab(tabId) {
  try {
    const groupId = await chromeAsync((done) => {
      chrome.tabs.group({ tabIds: [tabId] }, done);
    });
    await chromeAsync((done) => {
      chrome.tabGroups.update(groupId, {
        title: GROUP_TITLE,
        color: GROUP_COLOR,
        collapsed: false
      }, done);
    });
  } catch {
    // Tab Groups API can fail for special windows; automation can still run.
  }
}

async function ungroupBrowseTab(tabId) {
  if (!tabId) return;
  try {
    await chromeAsync((done) => chrome.tabs.ungroup(tabId, done));
  } catch {
    // The tab may already be closed or ungrouped.
  }
}

async function keepTabFromDiscarding(tabId) {
  try {
    await tabUpdate(tabId, { autoDiscardable: false });
  } catch {
    // Older Chrome builds or special tabs may reject this flag.
  }
}

async function stopSession({ status = 'stopped', error = null, fromDetach = false } = {}) {
  if (stoppingPromise) return stoppingPromise;

  stoppingPromise = (async () => {
    const tabId = session.tabId;
    const shouldDetach = session.debuggerAttached && tabId && !fromDetach;

    session.stopRequested = true;
    session.isRunning = false;

    if (shouldDetach) {
      session.expectedDetach = true;
      try {
        await detachDebugger(tabId);
      } catch {
        // Detach can fail if Chrome already detached or the tab is gone.
      }
    }

    session.debuggerAttached = false;
    await ungroupBrowseTab(tabId);
    await updateStatus(status, error ? { error } : {});
    resetSession();
  })().finally(() => {
    stoppingPromise = null;
  });

  return stoppingPromise;
}

async function runBrowseSession() {
  try {
    while (session.isRunning) {
      const shouldContinue = await browseCurrentListPage();
      if (!shouldContinue) return;
    }
  } catch (err) {
    if (err instanceof StopRequested) return;
    await stopSession({ error: err.message || '自动浏览失败' });
  }
}

async function browseCurrentListPage() {
  ensureRunning();
  await navigateTo(session.currentListUrl);

  const listInfo = await waitForListInfo(session.currentListUrl);
  if (listInfo.loginRequired || isLoginLikeUrl(listInfo.href)) {
    throw new Error('请先登录 LinuxDo 后再启动自动浏览');
  }

  if (listInfo.topics.length === 0) {
    session.noTopicRetries += 1;
    await updateStatus('no-topics', { error: '未找到帖子，稍后重试' });
    if (session.noTopicRetries >= MAX_NO_TOPIC_RETRIES) {
      throw new Error('连续多次未找到帖子，已停止');
    }
    await interruptibleDelay(5000, 8000);
    return true;
  }

  session.noTopicRetries = 0;

  if (session.currentTopicIndex >= listInfo.topics.length) {
    if (!listInfo.nextHref) {
      await stopSession({ status: 'complete' });
      return false;
    }

    session.currentListUrl = listInfo.nextHref;
    session.currentTopicIndex = 0;
    await updateStatus('next-page');
    await interruptibleDelay(800, 1500);
    return true;
  }

  const topic = listInfo.topics[session.currentTopicIndex];
  await updateStatus('browsing', {
    total: listInfo.topics.length,
    current: session.currentTopicIndex,
    title: topic.title
  });

  await browseTopic(topic, listInfo.topics.length);
  session.currentTopicIndex += 1;
  return true;
}

async function browseTopic(topic, total) {
  ensureRunning();

  await navigateTo(topic.href);
  await updateStatus('on-topic', {
    total,
    current: session.currentTopicIndex,
    title: topic.title
  });

  const ready = await waitForTopicContent(topic.href);
  if (!ready) {
    await updateStatus('topic-error', {
      total,
      current: session.currentTopicIndex,
      title: topic.title,
      error: '帖子内容加载超时，已跳过'
    });
    await interruptibleDelay(500, 1000);
    return;
  }

  await interruptibleDelay(1500, 3000);
  await ensureExpectedLocation(topic.href);
  await evaluateInPage(() => {
    window.scrollTo(0, 0);
    return true;
  });
  await interruptibleDelay(1000, 2000);
  await autoScrollTopic(topic.href);
  await interruptibleDelay(2000, 5000);
}

async function navigateTo(url) {
  ensureRunning();
  await sendCdpCommand('Page.navigate', { url });
  await waitForDocumentReady();
}

async function waitForDocumentReady(timeout = 30000) {
  return waitUntil(async () => {
    const state = await evaluateInPage(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title
    }));

    if (!isLinuxDoUrl(state.href)) {
      throw new Error('自动化标签已离开 linux.do，已停止');
    }

    if (state.readyState === 'interactive' || state.readyState === 'complete') {
      return state;
    }

    return null;
  }, timeout, 300, '等待页面加载超时');
}

async function waitForListInfo(expectedUrl) {
  return waitUntil(async () => {
    await ensureExpectedLocation(expectedUrl);
    const info = await collectListInfo();
    if (info.topics.length > 0 || info.loginRequired || isLoginLikeUrl(info.href)) {
      return info;
    }

    if (documentLooksLoaded(info)) {
      return info;
    }

    return null;
  }, 20000, 300, '等待帖子列表超时');
}

function documentLooksLoaded(info) {
  return info.readyState === 'complete' && info.listReady;
}

async function collectListInfo() {
  return evaluateInPage(() => {
    const selectors = [
      '.topic-list-item .title a:not(.badge-notification)',
      '.topic-list-item a.raw-topic-link',
      '#list-area .main-link a',
      '.topic-list-item a[data-topic-id]'
    ];

    let topics = [];
    for (const selector of selectors) {
      topics = [...document.querySelectorAll(selector)]
        .filter((link) => {
          const href = link.href;
          if (!href || !href.includes('/t/') || href.includes('#')) return false;
          const item = link.closest('.topic-list-item');
          if (item && item.classList.contains('pinned')) return false;
          return true;
        })
        .map((link) => ({
          href: link.href,
          title: link.textContent.trim() || document.title
        }));

      if (topics.length > 0) break;
    }

    const next = document.querySelector('.next-page a, a[rel="next"], .pagination .next a');
    const listReady = Boolean(
      document.querySelector('#list-area, .topic-list, .topic-list-body, .topic-list-item')
    );
    const loginRequired = !document.querySelector('.topic-list-item') && Boolean(
      document.querySelector('button.login-button, a[href="/login"], .login-required, .login-welcome')
    );

    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body ? document.body.innerText.trim().length : 0,
      listReady,
      loginRequired,
      nextHref: next ? next.href : null,
      topics
    };
  });
}

async function waitForTopicContent(expectedUrl) {
  const result = await waitUntil(async () => {
    await ensureExpectedLocation(expectedUrl);
    return evaluateInPage(() => {
      const content = document.querySelector('.topic-body, #post_1, .cooked');
      const loginRequired = Boolean(
        document.querySelector('button.login-button, a[href="/login"], .login-required, .login-welcome')
      );

      if (loginRequired) {
        return { ready: false, loginRequired: true };
      }

      return {
        ready: Boolean(content && content.textContent.trim().length > 0),
        loginRequired: false
      };
    });
  }, 20000, 300, '等待帖子内容超时').catch((err) => {
    if (err instanceof StopRequested) throw err;
    if (/自动化标签|请先登录|已离开 linux\.do/.test(err.message || '')) throw err;
    return { ready: false, loginRequired: false };
  });

  if (result.loginRequired) {
    throw new Error('请先登录 LinuxDo 后再启动自动浏览');
  }

  return result.ready;
}

async function autoScrollTopic(expectedUrl) {
  const speedCfg = SPEED_CONFIG[session.speedSetting] || SPEED_CONFIG[2];
  let lastScrollY = -1;
  let stuckCount = 0;
  let deltaCarry = 0;

  while (session.isRunning) {
    await ensureExpectedLocation(expectedUrl);

    const metrics = await evaluateInPage(() => ({
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      scrollHeight: Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      )
    }));

    if (metrics.scrollY + metrics.innerHeight >= metrics.scrollHeight - 2) {
      return;
    }

    if (metrics.scrollY === lastScrollY) {
      stuckCount += 1;
      if (stuckCount > 30) return;
    } else {
      stuckCount = 0;
    }
    lastScrollY = metrics.scrollY;

    const speed = randomBetween(speedCfg.minSpeed, speedCfg.maxSpeed);
    const jitter = (Math.random() - 0.5) * 0.5;
    deltaCarry += Math.max(0.1, speed + jitter);
    const deltaY = Math.floor(deltaCarry);

    if (deltaY > 0) {
      deltaCarry -= deltaY;
      await scrollPageBy(deltaY);
    }

    if (Math.random() < 0.01) {
      await interruptibleDelay(100, 100);
      await scrollPageBy(-(10 + Math.random() * 20));
    }

    await interruptibleDelay(speedCfg.interval, speedCfg.interval);
  }

  throw new StopRequested();
}

async function scrollPageBy(deltaY) {
  await evaluateInPage((amount) => {
    window.scrollBy(0, amount);
    return window.scrollY;
  }, deltaY);
}

async function ensureExpectedLocation(expectedUrl) {
  ensureRunning();
  const actualUrl = await evaluateInPage(() => location.href);

  if (isLoginLikeUrl(actualUrl)) {
    throw new Error('请先登录 LinuxDo 后再启动自动浏览');
  }

  if (!isLinuxDoUrl(actualUrl)) {
    throw new Error('自动化标签已离开 linux.do，已停止');
  }

  if (samePageUrl(actualUrl, expectedUrl) || isSameTopicPage(actualUrl, expectedUrl)) {
    return;
  }

  const expectedTopicId = getTopicId(expectedUrl);
  if (expectedTopicId) {
    throw new Error('自动化标签被手动导航到其他页面，已停止');
  }

  throw new Error('自动化标签被手动导航，已停止');
}

async function evaluateInPage(fn, ...args) {
  const expression = `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
  const result = await sendCdpCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      '页面脚本执行失败';
    throw new Error(description);
  }

  return result.result ? result.result.value : undefined;
}

async function waitUntil(check, timeout, interval, timeoutMessage) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeout) {
    ensureRunning();
    try {
      const result = await check();
      if (result) return result;
    } catch (err) {
      if (err instanceof StopRequested) throw err;
      if (/自动化标签|请先登录|已离开 linux\.do/.test(err.message || '')) throw err;
      lastError = err;
    }

    await interruptibleDelay(interval, interval);
  }

  if (lastError && !/Cannot find context|Execution context/.test(lastError.message)) {
    throw lastError;
  }

  throw new Error(timeoutMessage);
}

async function interruptibleDelay(min, max) {
  const duration = randomBetween(min, max);
  const end = Date.now() + duration;

  while (Date.now() < end) {
    ensureRunning();
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, end - Date.now())));
  }
}

function respond(sendResponse, promise) {
  promise
    .then((response) => sendResponse(response))
    .catch((err) => sendResponse({ error: err.message || '操作失败' }));
  return true;
}

function clearPersistedRunningState() {
  storageSet({
    cdpIsRunning: false,
    contentIsRunning: false,
    automationMode: 'cdp'
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'browse-status') {
    // Ignore legacy content-script status messages; CDP is the source of truth.
    return;
  }

  if (msg.type === 'start-browse') {
    return respond(sendResponse, startBrowse());
  }

  if (msg.type === 'stop-browse') {
    return respond(sendResponse, stopBrowse());
  }

  if (msg.type === 'focus-browse-tab') {
    return respond(sendResponse, focusBrowseTab());
  }

  if (msg.type === 'get-background-status') {
    return respond(sendResponse, getBackgroundStatus());
  }

  if (msg.type === 'set-speed') {
    return respond(sendResponse, setSpeed(msg.speed));
  }
});

chrome.runtime.onInstalled.addListener(clearPersistedRunningState);
chrome.runtime.onStartup.addListener(clearPersistedRunningState);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === session.tabId) {
    stopSession({ error: '自动化标签已关闭', fromDetach: true });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    tabId === session.tabId &&
    session.isRunning &&
    session.debuggerAttached &&
    changeInfo.url &&
    !isLinuxDoUrl(changeInfo.url)
  ) {
    stopSession({ error: '自动化标签已离开 linux.do，已停止' });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (
    source.tabId === session.tabId &&
    session.debuggerAttached &&
    !session.expectedDetach
  ) {
    stopSession({
      error: readableDetachReason(reason),
      fromDetach: true
    });
  }
});
