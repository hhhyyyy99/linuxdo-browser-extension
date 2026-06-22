// Background service worker - manages browsing tab grouping and messaging

let browseTabId = null;

const GROUP_TITLE = 'LinuxDo 刷帖';
const GROUP_COLOR = 'cyan';

// Handle all messages from popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Status updates from content script
  if (msg.type === 'browse-status') {
    const data = {
      browseStatus: msg.status,
      browseData: {
        total: msg.total,
        current: msg.current,
        title: msg.title,
        error: msg.error
      },
      lastUpdate: Date.now()
    };

    if (sender.tab && sender.tab.id) {
      browseTabId = sender.tab.id;
      data.browseTabId = sender.tab.id;
    }

    chrome.storage.local.set(data);

    if (['complete', 'stopped'].includes(msg.status)) {
      ungroupBrowseTab(browseTabId);
      browseTabId = null;
      chrome.storage.local.set({ browseTabId: null });
    }
    return;
  }

  // Start browse - find linux.do tab, group it, send start command
  if (msg.type === 'start-browse') {
    findLinuxDoTab().then(async (tab) => {
      if (!tab) {
        sendResponse({ error: '请先打开一个 linux.do 标签页' });
        return;
      }

      browseTabId = tab.id;
      chrome.storage.local.set({ browseTabId: tab.id });

      // Put tab into a group
      await groupBrowseTab(tab.id);

      // Ensure content script is injected
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'get-status' });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await new Promise(r => setTimeout(r, 500));
      }

      // Send start command
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'start-browse' });
        sendResponse(resp || { status: 'started' });
      } catch (e) {
        sendResponse({ error: '无法启动浏览' });
      }
    }).catch((e) => {
      sendResponse({ error: '启动失败: ' + e.message });
    });
    return true; // async
  }

  // Stop browse
  if (msg.type === 'stop-browse') {
    // Clear persisted running state
    chrome.storage.local.set({ contentIsRunning: false });
    if (browseTabId) {
      chrome.tabs.sendMessage(browseTabId, { type: 'stop-browse' }).then(() => {
        ungroupBrowseTab(browseTabId);
        browseTabId = null;
        chrome.storage.local.set({ browseTabId: null });
        sendResponse({ status: 'stopped' });
      }).catch(() => {
        browseTabId = null;
        sendResponse({ status: 'stopped' });
      });
    } else {
      sendResponse({ status: 'not-running' });
    }
    return true;
  }

  // Focus the browse tab
  if (msg.type === 'focus-browse-tab') {
    if (browseTabId) {
      chrome.tabs.get(browseTabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          chrome.windows.update(tab.windowId, { focused: true });
          chrome.tabs.update(browseTabId, { active: true });
        }
      });
    }
    return;
  }
});

// Find the most recent linux.do tab
async function findLinuxDoTab() {
  const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
  if (tabs.length === 0) return null;
  // Prefer the active tab if it's linux.do
  const active = tabs.find(t => t.active);
  return active || tabs[0];
}

// Group the browse tab visually
async function groupBrowseTab(tabId) {
  try {
    const groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: undefined }
    });
    await chrome.tabGroups.update(groupId, {
      title: GROUP_TITLE,
      color: GROUP_COLOR,
      collapsed: false
    });
  } catch (e) {
    // Tab Groups API may not be available
  }
}

// Remove tab from its group when done
async function ungroupBrowseTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.ungroup(tabId);
  } catch (e) {
    // Tab may already be closed or not in a group
  }
}

// Clean up when browse tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === browseTabId) {
    browseTabId = null;
    chrome.storage.local.set({
      browseTabId: null,
      browseStatus: 'stopped',
      contentIsRunning: false
    });
  }
});
