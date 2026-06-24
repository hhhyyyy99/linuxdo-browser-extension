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
  5: { minSpeed: 24, maxSpeed: 56, interval: 70, bottomStableMs: 1800, stuckStableMs: 900 }
};

const session = createEmptySession();
let stoppingPromise = null;
let currentAgentSession = null;
let currentBrowseRunSession = null;

const MAX_SESSIONS = 100;
const MAX_BROWSE_RUN_SESSIONS = 100;

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
    speedSetting: 2,
    postLimit: 0,
    totalBrowsed: 0
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

  const saved = await storageGet(['speedSetting', 'postLimit']).catch(() => ({}));
  session.speedSetting = Number(saved.speedSetting) || 2;
  session.postLimit = Number(saved.postLimit) || 0;
  session.totalBrowsed = 0;
  session.stopRequested = false;
  session.currentListUrl = LINUXDO_LATEST_URL;
  session.currentTopicIndex = 0;
  session.noTopicRetries = 0;

  // Create new agent session for topic recording
  currentAgentSession = createAgentSession();
  await saveCurrentSessionSnapshot();
  currentBrowseRunSession = createBrowseRunSession();
  await saveCurrentBrowseRunSnapshot();

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

async function setPostLimit(postLimit) {
  session.postLimit = Math.max(0, Number(postLimit) || 0);
  await storageSet({ postLimit: session.postLimit });
  return { status: 'ok' };
}

// ── Agent API ──────────────────────────────────────────────────

const CRYPTO_SALT_KEY = 'agentCryptoSalt';

async function decryptApiKey(encrypted) {
  if (!encrypted) return '';
  try {
    const { [CRYPTO_SALT_KEY]: salt } = await storageGet([CRYPTO_SALT_KEY]);
    if (!salt) return encrypted; // Not encrypted (legacy)

    const enc = new TextEncoder();
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(chrome.runtime.id + salt), 'PBKDF2', false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const cipher = data.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return encrypted; // Fallback: treat as plaintext
  }
}

async function getAgentConfig() {
  const saved = await storageGet(['agentBaseUrl', 'agentApiKey', 'agentModel', 'agentPreference']).catch(() => ({}));
  const apiKey = await decryptApiKey(saved.agentApiKey || '');

  return {
    baseUrl: (saved.agentBaseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model: saved.agentModel || 'gpt-4o-mini',
    preference: saved.agentPreference || ''
  };
}

async function callAgent(messages) {
  const config = await getAgentConfig();
  if (!config.baseUrl || !config.apiKey) {
    throw new Error('请先配置 Agent 的 BaseURL 和 API Key');
  }

  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Agent API 错误 ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function filterTopic(title, href) {
  const config = await getAgentConfig();
  if (!config.baseUrl || !config.apiKey || !config.preference) return false;

  try {
    const result = await callAgent([
      {
        role: 'system',
        content: `你是一个话题过滤器。用户偏好：${config.preference}\n判断给定话题是否匹配用户偏好。只回复 "yes" 或 "no"，不要回复其他内容。`
      },
      { role: 'user', content: `话题标题：${title}` }
    ]);
    return result.trim().toLowerCase().startsWith('yes');
  } catch {
    return false;
  }
}

async function generateSummary(topics) {
  const config = await getAgentConfig();
  if (!config.baseUrl || !config.apiKey) {
    throw new Error('请先配置 Agent 的 BaseURL 和 API Key');
  }

  const topicList = topics.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  const result = await callAgent([
    {
      role: 'system',
      content: `你是一个话题总结助手。用户偏好：${config.preference}\n请将以下话题按类别分类总结，使用 Markdown 格式。每个类别用二级标题，话题用列表项（加粗标题并附链接）。如果没有匹配偏好的话题，说明没有找到相关话题。`
    },
    {
      role: 'user',
      content: `以下是浏览过的话题列表：\n${topicList}\n\n请用以下 JSON 格式返回（不要有其他内容）：\n{"topics": [{"index": 1, "category": "类别名"}], "summary": "Markdown 格式的总结"}`
    }
  ]);

  try {
    const parsed = JSON.parse(result);
    return parsed.summary || result;
  } catch {
    return result;
  }
}

// ── Session Management ─────────────────────────────────────────

function createAgentSession() {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    startTime: new Date().toISOString(),
    topics: [],
    summary: ''
  };
}

function createBrowseRunSession() {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    startTime: new Date().toISOString(),
    endTime: '',
    status: 'running',
    topics: []
  };
}

async function saveAgentSession(sessionToSave) {
  const { agentSessions = [] } = await storageGet(['agentSessions']).catch(() => ({}));
  agentSessions.unshift(sessionToSave);
  // Keep only the latest MAX_SESSIONS
  while (agentSessions.length > MAX_SESSIONS) agentSessions.pop();
  await storageSet({ agentSessions });
}

async function saveBrowseRunSession(sessionToSave) {
  const { browseRunSessions = [] } = await storageGet(['browseRunSessions']).catch(() => ({}));
  browseRunSessions.unshift(sessionToSave);
  while (browseRunSessions.length > MAX_BROWSE_RUN_SESSIONS) browseRunSessions.pop();
  await storageSet({ browseRunSessions });
}

async function saveCurrentSessionSnapshot() {
  if (!currentAgentSession) return;
  await storageSet({ currentAgentSnapshot: currentAgentSession });
}

async function saveCurrentBrowseRunSnapshot() {
  if (!currentBrowseRunSession) return;
  await storageSet({ currentBrowseRunSnapshot: currentBrowseRunSession });
}

async function clearCurrentSessionSnapshot() {
  await storageSet({ currentAgentSnapshot: null });
}

async function clearCurrentBrowseRunSnapshot() {
  await storageSet({ currentBrowseRunSnapshot: null });
}

async function recordBrowsedTopic(topic) {
  if (!currentBrowseRunSession) return;

  currentBrowseRunSession.topics.push({
    title: topic.title,
    href: topic.href,
    browsedAt: new Date().toISOString(),
    status: 'browsing',
    error: ''
  });
  await saveCurrentBrowseRunSnapshot();
}

async function updateBrowsedTopicStatus(topic, status, error = '') {
  if (!currentBrowseRunSession) return;

  const record = [...currentBrowseRunSession.topics].reverse()
    .find((item) => item.href === topic.href);
  if (!record) return;

  record.status = status;
  record.error = error;
  record.completedAt = new Date().toISOString();
  await saveCurrentBrowseRunSnapshot();
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

    if (currentBrowseRunSession) {
      currentBrowseRunSession.endTime = new Date().toISOString();
      currentBrowseRunSession.status = error ? 'error' : status;
      await saveBrowseRunSession(currentBrowseRunSession);
    }
    currentBrowseRunSession = null;
    await clearCurrentBrowseRunSnapshot();

    // Save agent session if it has recorded topics
    if (currentAgentSession && currentAgentSession.topics.length > 0) {
      await saveAgentSession(currentAgentSession);
    }
    currentAgentSession = null;
    await clearCurrentSessionSnapshot();

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
    // All topics on this page browsed — try loading more via infinite scroll
    const loaded = await loadMoreTopics();
    if (!loaded) {
      await stopSession({ status: 'complete' });
      return false;
    }
    // Re-navigate to pick up newly loaded topics
    session.currentTopicIndex = 0;
    await updateStatus('next-page');
    await interruptibleDelay(800, 1500);
    return true;
  }

  const topic = listInfo.topics[session.currentTopicIndex];
  await updateStatus('browsing', {
    total: listInfo.topics.length,
    current: session.currentTopicIndex,
    title: topic.title,
    totalBrowsed: session.totalBrowsed,
    postLimit: session.postLimit
  });

  await browseTopic(topic, listInfo.topics.length);
  session.currentTopicIndex += 1;
  session.totalBrowsed += 1;

  // Agent: filter and record topic
  if (currentAgentSession) {
    try {
      const matched = await filterTopic(topic.title, topic.href);
      if (matched) {
        currentAgentSession.topics.push({ title: topic.title, href: topic.href });
        await saveCurrentSessionSnapshot();
      }
    } catch {
      // Agent filtering failed — silently skip, don't break browsing
    }
  }

  if (session.postLimit > 0 && session.totalBrowsed >= session.postLimit) {
    await stopSession({ status: 'complete' });
    return false;
  }

  return true;
}

async function browseTopic(topic, total) {
  ensureRunning();

  await navigateTo(topic.href);
  await recordBrowsedTopic(topic);
  await updateStatus('on-topic', {
    total,
    current: session.currentTopicIndex,
    title: topic.title,
    totalBrowsed: session.totalBrowsed,
    postLimit: session.postLimit
  });

  const ready = await waitForTopicContent(topic.href);
  if (!ready) {
    await updateBrowsedTopicStatus(topic, 'error', '帖子内容加载超时，已跳过');
    await updateStatus('topic-error', {
      total,
      current: session.currentTopicIndex,
      title: topic.title,
      error: '帖子内容加载超时，已跳过',
      totalBrowsed: session.totalBrowsed,
      postLimit: session.postLimit
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
  await updateBrowsedTopicStatus(topic, 'success');
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

async function loadMoreTopics() {
  // Scroll to the bottom to trigger Discourse's infinite scroll
  const initialCount = await evaluateInPage(() => {
    return document.querySelectorAll('.topic-list-item').length;
  });

  // Try scrolling to the bottom multiple times to trigger lazy-load
  for (let attempt = 0; attempt < 10; attempt++) {
    ensureRunning();

    await evaluateInPage(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      // Also try clicking the "Load More" button if it exists
      const btn = document.querySelector('.load-more button, .load-more a');
      if (btn) btn.click();
    });

    await interruptibleDelay(1500, 2500);

    const newCount = await evaluateInPage(() => {
      return document.querySelectorAll('.topic-list-item').length;
    });

    if (newCount > initialCount) {
      return true;
    }
  }

  return false;
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
  const bottomCountLimit = getScrollIterationLimit(speedCfg, 'bottomStableMs', 80);
  const stuckCountLimit = getScrollIterationLimit(speedCfg, 'stuckStableMs', 30);
  let lastScrollY = -1;
  let stuckCount = 0;
  let bottomCount = 0;
  let lastScrollHeight = 0;
  let deltaCarry = 0;

  while (session.isRunning) {
    // Single CDP call: check URL + read scroll metrics + perform scroll
    const speed = randomBetween(speedCfg.minSpeed, speedCfg.maxSpeed);
    const jitter = (Math.random() - 0.5) * 0.5;
    deltaCarry += Math.max(0.1, speed + jitter);
    const deltaY = Math.floor(deltaCarry);
    if (deltaY > 0) deltaCarry -= deltaY;

    const doReverseScroll = Math.random() < 0.01;
    const reverseAmount = doReverseScroll ? -(10 + Math.random() * 20) : 0;

    const result = await evaluateInPage((scrollAmt, reverseAmt) => {
      const href = location.href;
      const scrollY = window.scrollY;
      const innerHeight = window.innerHeight;
      const scrollHeight = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      const atBottom = scrollY + innerHeight >= scrollHeight - 2;

      let newY = scrollY;
      if (!atBottom && scrollAmt > 0) {
        window.scrollBy(0, scrollAmt);
        newY = window.scrollY;
      }
      if (reverseAmt !== 0 && !atBottom) {
        window.scrollBy(0, reverseAmt);
        newY = window.scrollY;
      }

      return { href, scrollY: newY, innerHeight, scrollHeight, atBottom };
    }, deltaY, reverseAmount);

    // Validate URL
    if (isLoginLikeUrl(result.href)) {
      throw new Error('请先登录 LinuxDo 后再启动自动浏览');
    }
    if (!isLinuxDoUrl(result.href)) {
      throw new Error('自动化标签已离开 linux.do，已停止');
    }
    if (!samePageUrl(result.href, expectedUrl) && !isSameTopicPage(result.href, expectedUrl)) {
      const expectedTopicId = getTopicId(expectedUrl);
      if (expectedTopicId) {
        throw new Error('自动化标签被手动导航到其他页面，已停止');
      }
      throw new Error('自动化标签被手动导航，已停止');
    }

    // Bottom detection with lazy-load wait
    if (result.atBottom) {
      if (result.scrollHeight > lastScrollHeight) {
        bottomCount = 0;
        stuckCount = 0;
        lastScrollHeight = result.scrollHeight;
      } else {
        bottomCount += 1;
        if (bottomCount > bottomCountLimit) return;
      }
      await interruptibleDelay(speedCfg.interval, speedCfg.interval);
      continue;
    }

    bottomCount = 0;
    lastScrollHeight = result.scrollHeight;

    // Stuck detection
    if (result.scrollY === lastScrollY) {
      stuckCount += 1;
      if (stuckCount > stuckCountLimit) return;
    } else {
      stuckCount = 0;
    }
    lastScrollY = result.scrollY;

    await interruptibleDelay(speedCfg.interval, speedCfg.interval);
  }

  throw new StopRequested();
}

function getScrollIterationLimit(speedCfg, durationKey, defaultIterations) {
  const duration = Number(speedCfg[durationKey]) || 0;
  if (duration <= 0) return defaultIterations;

  return Math.max(1, Math.ceil(duration / speedCfg.interval));
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

  if (msg.type === 'set-post-limit') {
    return respond(sendResponse, setPostLimit(msg.postLimit));
  }

  if (msg.type === 'get-agent-sessions') {
    return respond(sendResponse, (async () => {
      const { agentSessions = [] } = await storageGet(['agentSessions']).catch(() => ({}));
      const { currentAgentSnapshot = null } = await storageGet(['currentAgentSnapshot']).catch(() => ({}));
      return { sessions: agentSessions, current: currentAgentSnapshot };
    })());
  }

  if (msg.type === 'get-browse-run-sessions') {
    return respond(sendResponse, (async () => {
      const { browseRunSessions = [] } = await storageGet(['browseRunSessions']).catch(() => ({}));
      const { currentBrowseRunSnapshot = null } = await storageGet(['currentBrowseRunSnapshot']).catch(() => ({}));
      return { sessions: browseRunSessions, current: currentBrowseRunSnapshot };
    })());
  }

  if (msg.type === 'generate-summary') {
    return respond(sendResponse, (async () => {
      const { agentSessions = [] } = await storageGet(['agentSessions']).catch(() => ({}));
      const target = agentSessions.find((s) => s.id === msg.sessionId);
      if (!target) throw new Error('会话不存在');
      if (target.topics.length === 0) throw new Error('该会话没有记录的话题');
      const summary = await generateSummary(target.topics);
      target.summary = summary;
      await storageSet({ agentSessions });
      return { summary };
    })());
  }

  if (msg.type === 'delete-session') {
    return respond(sendResponse, (async () => {
      const { agentSessions = [] } = await storageGet(['agentSessions']).catch(() => ({}));
      const filtered = agentSessions.filter((s) => s.id !== msg.sessionId);
      await storageSet({ agentSessions: filtered });
      return { status: 'ok' };
    })());
  }

  if (msg.type === 'test-agent') {
    return respond(sendResponse, (async () => {
      try {
        const result = await callAgent([
          { role: 'user', content: '请回复"连接成功"四个字' }
        ]);
        return { status: 'ok', message: result };
      } catch (err) {
        return { error: err.message };
      }
    })());
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
