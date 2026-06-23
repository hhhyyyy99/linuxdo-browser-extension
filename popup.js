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
let isStarting = false;

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
  const safeCurrent = Number(current) || 0;
  const safeTotal = Math.max(Number(total) || 0, safeCurrent + 1, 1);

  progress.classList.remove('hidden');
  topicInfo.classList.remove('hidden');
  progressText.textContent = `${safeCurrent + 1} / ${safeTotal}`;
  progressFill.style.width = `${Math.min(100, ((safeCurrent + 1) / safeTotal) * 100)}%`;
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

function sendToBackground(msg, callback = () => {}) {
  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) {
      callback(null);
      return;
    }
    callback(resp || null);
  });
}

function applyBrowseStatus(status, data = {}) {
  switch (status) {
    case 'starting':
      updateUI(true);
      setStatus('启动中...', 'running');
      break;
    case 'resuming':
      updateUI(true);
      setStatus('恢复中...', 'running');
      break;
    case 'browsing':
      updateUI(true);
      showProgress(data.current || 0, data.total || 0, data.title);
      break;
    case 'on-topic':
      updateUI(true);
      if (data.total) {
        setStatus(`浏览帖子 (${(data.current || 0) + 1}/${data.total})`, 'running');
      } else {
        setStatus('浏览帖子', 'running');
      }
      showProgress(data.current || 0, data.total || 0, data.title);
      break;
    case 'next-page':
      updateUI(true);
      setStatus('翻页中...', 'running');
      break;
    case 'topic-error':
      updateUI(true);
      setStatus('跳过失败帖子', 'running');
      showProgress(data.current || 0, data.total || 0, data.title);
      if (data.error) showError(data.error);
      break;
    case 'complete':
      updateUI(false);
      setStatus('全部完成', 'complete');
      break;
    case 'stopped':
      updateUI(false);
      if (data.error) {
        setStatus('已停止', 'error');
        showError(data.error);
      } else {
        setStatus('已停止', '');
      }
      break;
    case 'no-topics':
      updateUI(true);
      setStatus('未找到帖子，重试中...', 'error');
      if (data.error) showError(data.error);
      break;
  }
}

btnStart.addEventListener('click', () => {
  hideError();
  isStarting = true;
  setStatus('启动中...', '');

  sendToBackground({ type: 'start-browse' }, (resp) => {
    if (!resp) {
      isStarting = false;
      showError('通信失败，请重试');
      setStatus('就绪', '');
      return;
    }

    if (resp.error) {
      isStarting = false;
      showError(resp.error);
      setStatus('就绪', '');
      return;
    }

    setTimeout(() => {
      if (isStarting) updateUI(true);
    }, 8000);
  });
});

btnStop.addEventListener('click', () => {
  sendToBackground({ type: 'stop-browse' }, () => {
    chrome.storage.local.set({
      cdpIsRunning: false,
      contentIsRunning: false
    });
    updateUI(false);
    setStatus('已停止', '');
  });
});

btnView.addEventListener('click', () => {
  if (browseTabId) {
    sendToBackground({ type: 'focus-browse-tab' });
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.browseTabId) {
    browseTabId = changes.browseTabId.newValue;
  }

  if (changes.browseStatus) {
    const status = changes.browseStatus.newValue;
    const data = changes.browseData?.newValue || {};
    applyBrowseStatus(status, data);
  }
});

chrome.storage.local.get(
  ['speedSetting', 'browseTabId', 'browseStatus', 'browseData', 'cdpIsRunning'],
  (result) => {
    const savedSpeed = result.speedSetting || 2;
    speedSlider.value = savedSpeed;
    updateSpeedLabel(savedSpeed);

    browseTabId = result.browseTabId || null;
    updateUI(false);

    sendToBackground({ type: 'get-background-status' }, (resp) => {
      if (!resp) {
        if (result.cdpIsRunning && result.browseStatus) {
          applyBrowseStatus(result.browseStatus, result.browseData || {});
        }
        return;
      }

      browseTabId = resp.browseTabId || result.browseTabId || null;

      if (resp.isRunning) {
        applyBrowseStatus(resp.status || result.browseStatus || 'starting', resp.data || result.browseData || {});
        return;
      }

      if (result.browseStatus === 'complete' || (result.browseStatus === 'stopped' && result.browseData?.error)) {
        applyBrowseStatus(result.browseStatus, result.browseData || {});
      }
    });
  }
);

speedSlider.addEventListener('input', () => {
  const value = parseInt(speedSlider.value, 10);
  updateSpeedLabel(value);
  chrome.storage.local.set({ speedSetting: value });
  sendToBackground({ type: 'set-speed', speed: value });
});
