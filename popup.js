const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnView = document.getElementById('btn-view');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const progress = document.getElementById('progress');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');
const topicInfo = document.getElementById('topic-info');
const topicTitle = document.getElementById('topic-title');
const speedSlider = document.getElementById('speed-slider');
const speedText = document.getElementById('speed-text');
const errorMsg = document.getElementById('error-msg');

const SPEED_LABELS = { 1: '极慢', 2: '慢速', 3: '中速', 4: '快速', 5: '极快' };

let browseTabId = null;
let isStarting = false; // guard against stale storage events during startup

function updateSpeedLabel(value) {
  speedText.textContent = SPEED_LABELS[value] || '慢速';
}

function setStatus(text, state = '') {
  statusText.textContent = text;
  statusDot.className = state ? `running ${state}` : '';
  if (state === 'running') statusDot.classList.add('running');
  if (state === 'error') statusDot.classList.add('error');
  if (state === 'complete') statusDot.classList.add('complete');
}

function showProgress(current, total, title) {
  progress.classList.remove('hidden');
  topicInfo.classList.remove('hidden');
  progressText.textContent = `${current + 1} / ${total}`;
  progressFill.style.width = `${((current + 1) / total) * 100}%`;
  if (title) topicTitle.textContent = title;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

function hideError() {
  errorMsg.classList.add('hidden');
}

function updateUI(running) {
  isStarting = false;
  if (running) {
    btnStart.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnView.classList.remove('hidden');
    setStatus('运行中...', 'running');
  } else {
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    btnView.classList.add('hidden');
    progress.classList.add('hidden');
    topicInfo.classList.add('hidden');
    setStatus('就绪', '');
  }
}

async function sendToContent(msg) {
  if (!browseTabId) return null;
  try {
    return await chrome.tabs.sendMessage(browseTabId, msg);
  } catch (e) {
    return null;
  }
}

// Start: tell background to find linux.do tab, group it, and start browsing
btnStart.addEventListener('click', () => {
  hideError();
  isStarting = true;
  setStatus('启动中...', '');

  chrome.runtime.sendMessage({ type: 'start-browse' }, (resp) => {
    if (chrome.runtime.lastError) {
      isStarting = false;
      showError('通信失败，请重试');
      setStatus('就绪', '');
      return;
    }
    if (resp && resp.error) {
      isStarting = false;
      showError(resp.error);
      setStatus('就绪', '');
      return;
    }
    // Don't update UI here — let the storage listener handle it
    // when the content script sends its first browse-status notification.
    // Safety fallback: if no storage event arrives in 8s, assume started.
    setTimeout(() => {
      if (isStarting) {
        updateUI(true);
      }
    }, 8000);
  });
});

// Stop: tell background to stop and ungroup
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop-browse' }, () => {
    chrome.storage.local.set({ contentIsRunning: false });
    updateUI(false);
    setStatus('已停止', '');
  });
});

// View browse tab
btnView.addEventListener('click', () => {
  if (browseTabId) {
    chrome.runtime.sendMessage({ type: 'focus-browse-tab' });
  }
});

// Listen for status updates from background — primary UI driver
chrome.storage.onChanged.addListener((changes) => {
  if (changes.browseStatus) {
    const status = changes.browseStatus.newValue;
    const data = changes.browseData?.newValue || {};

    switch (status) {
      case 'starting':
        setStatus('启动中...', 'running');
        break;
      case 'resuming':
        setStatus('恢复中...', 'running');
        break;
      case 'browsing':
        updateUI(true);
        showProgress(data.current || 0, data.total || 0, data.title);
        break;
      case 'on-topic':
        updateUI(true);
        setStatus(`浏览帖子 (${(data.current || 0) + 1}/${data.total || 0})`, 'running');
        showProgress(data.current || 0, data.total || 0, data.title);
        break;
      case 'next-page':
        setStatus('翻页中...', 'running');
        break;
      case 'topic-error':
        setStatus('跳过失败帖子', 'running');
        if (data.error) showError(data.error);
        break;
      case 'complete':
        setStatus('全部完成', 'complete');
        updateUI(false);
        break;
      case 'stopped':
        updateUI(false);
        if (data.error) {
          showError(data.error);
        } else {
          setStatus('已停止', '');
        }
        break;
      case 'no-topics':
        setStatus('未找到帖子', 'error');
        break;
    }
  }

  if (changes.browseTabId) {
    browseTabId = changes.browseTabId.newValue;
  }
});

// Load saved settings on popup open
chrome.storage.local.get(['speedSetting', 'browseTabId', 'browseStatus'], (result) => {
  const savedSpeed = result.speedSetting || 2;
  speedSlider.value = savedSpeed;
  updateSpeedLabel(savedSpeed);

  browseTabId = result.browseTabId || null;

  // Default to stopped state — verification below may override
  updateUI(false);

  // If storage says running, verify with the actual content script
  if (browseTabId && result.browseStatus && !['stopped', 'complete'].includes(result.browseStatus)) {
    setStatus('检查状态...', '');
    chrome.tabs.sendMessage(browseTabId, { type: 'get-status' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.isRunning) {
        chrome.storage.local.set({
          browseStatus: 'stopped',
          browseTabId: null,
          contentIsRunning: false
        });
        browseTabId = null;
        updateUI(false);
      } else {
        updateUI(true);
      }
    });
  }
});

speedSlider.addEventListener('input', () => {
  const value = parseInt(speedSlider.value);
  updateSpeedLabel(value);
  chrome.storage.local.set({ speedSetting: value });
  sendToContent({ type: 'set-speed', speed: value });
});
