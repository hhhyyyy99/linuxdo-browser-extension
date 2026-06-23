// ── DOM Elements ────────────────────────────────────────────
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
const postLimitInput = document.getElementById('post-limit');
const limitText = document.getElementById('limit-text');
const errorMsg = document.getElementById('error-msg');

const agentBaseUrl = document.getElementById('agent-baseurl');
const agentApiKey = document.getElementById('agent-apikey');
const agentModel = document.getElementById('agent-model');
const agentPreference = document.getElementById('agent-preference');
const btnToggleKey = document.getElementById('btn-toggle-key');
const btnSaveAgent = document.getElementById('btn-save-agent');
const btnTestAgent = document.getElementById('btn-test-agent');
const agentMsg = document.getElementById('agent-msg');

const sessionList = document.getElementById('session-list');
const summaryEmpty = document.getElementById('summary-empty');

const SPEED_LABELS = { 1: '极慢', 2: '慢速', 3: '中速', 4: '快速', 5: '极快' };

let browseTabId = null;
let isStarting = false;

// ── Tab Switching ───────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'summary') loadSessions();
  });
});

// ── Speed & Limit ───────────────────────────────────────────
function updateSpeedLabel(value) {
  speedText.textContent = SPEED_LABELS[value] || '慢速';
}

function updateLimitLabel(value) {
  limitText.textContent = value > 0 ? String(value) : '∞';
}

// ── Status & Progress ───────────────────────────────────────
function setStatus(text, state = '') {
  statusText.textContent = text;
  statusDot.className = state ? `running ${state}` : '';
  if (state === 'running') statusDot.classList.add('running');
  if (state === 'error') statusDot.classList.add('error');
  if (state === 'complete') statusDot.classList.add('complete');
}

function showProgress(current, total, title) {
  const safeCurrent = Number(current) || 0;
  const isUnlimited = !total || total <= 0;

  progress.classList.remove('hidden');
  topicInfo.classList.remove('hidden');

  if (isUnlimited) {
    progressText.textContent = `${safeCurrent} / ∞`;
    progressFill.style.width = '100%';
  } else {
    const safeTotal = Math.max(Number(total) || 0, safeCurrent + 1, 1);
    progressText.textContent = `${safeCurrent} / ${safeTotal}`;
    progressFill.style.width = `${Math.min(100, (safeCurrent / safeTotal) * 100)}%`;
  }

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

// ── Background Communication ────────────────────────────────
function sendToBackground(msg, callback = () => {}) {
  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) {
      callback(null);
      return;
    }
    callback(resp || null);
  });
}

// ── Browse Status ───────────────────────────────────────────
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
      showProgress(data.totalBrowsed ?? data.current ?? 0, data.postLimit || data.total || 0, data.title);
      break;
    case 'on-topic':
      updateUI(true);
      if (data.totalBrowsed !== undefined) {
        const limit = data.postLimit || 0;
        const label = limit > 0 ? `${data.totalBrowsed} / ${limit}` : `${data.totalBrowsed} / ∞`;
        setStatus(`浏览帖子 ${label}`, 'running');
      } else if (data.total) {
        setStatus(`浏览帖子 (${(data.current || 0) + 1}/${data.total})`, 'running');
      } else {
        setStatus('浏览帖子', 'running');
      }
      showProgress(data.totalBrowsed ?? data.current ?? 0, data.postLimit || data.total || 0, data.title);
      break;
    case 'next-page':
      updateUI(true);
      setStatus('翻页中...', 'running');
      break;
    case 'topic-error':
      updateUI(true);
      setStatus('跳过失败帖子', 'running');
      showProgress(data.totalBrowsed ?? data.current ?? 0, data.postLimit || data.total || 0, data.title);
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

// ── Browse Buttons ──────────────────────────────────────────
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

// ── Storage Listeners ───────────────────────────────────────
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

// ── Init ────────────────────────────────────────────────────
chrome.storage.local.get(
  ['speedSetting', 'browseTabId', 'browseStatus', 'browseData', 'cdpIsRunning', 'postLimit',
   'agentBaseUrl', 'agentApiKey', 'agentModel', 'agentPreference'],
  (result) => {
    const savedSpeed = result.speedSetting || 2;
    speedSlider.value = savedSpeed;
    updateSpeedLabel(savedSpeed);

    const savedLimit = Number(result.postLimit) || 0;
    postLimitInput.value = savedLimit > 0 ? savedLimit : '';
    updateLimitLabel(savedLimit);

    agentBaseUrl.value = result.agentBaseUrl || '';
    agentApiKey.value = result.agentApiKey || '';
    agentModel.value = result.agentModel || '';
    agentPreference.value = result.agentPreference || '';

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

// ── Speed & Limit Listeners ─────────────────────────────────
speedSlider.addEventListener('input', () => {
  const value = parseInt(speedSlider.value, 10);
  updateSpeedLabel(value);
  chrome.storage.local.set({ speedSetting: value });
  sendToBackground({ type: 'set-speed', speed: value });
});

function savePostLimit() {
  const raw = postLimitInput.value.trim();
  const value = raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0);
  updateLimitLabel(value);
  chrome.storage.local.set({ postLimit: value });
  sendToBackground({ type: 'set-post-limit', postLimit: value });
}

postLimitInput.addEventListener('input', () => {
  const raw = postLimitInput.value;
  if (raw !== '' && !/^\d+$/.test(raw)) {
    postLimitInput.value = raw.replace(/\D/g, '');
  }
});

postLimitInput.addEventListener('change', savePostLimit);

postLimitInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    savePostLimit();
    postLimitInput.blur();
  }
});

// ── Agent Settings ──────────────────────────────────────────
function showAgentMsg(text, type) {
  agentMsg.textContent = text;
  agentMsg.className = type;
  agentMsg.classList.remove('hidden');
  setTimeout(() => agentMsg.classList.add('hidden'), 3000);
}

btnToggleKey.addEventListener('click', () => {
  agentApiKey.type = agentApiKey.type === 'password' ? 'text' : 'password';
});

btnSaveAgent.addEventListener('click', () => {
  const config = {
    agentBaseUrl: agentBaseUrl.value.trim(),
    agentModel: agentModel.value.trim(),
    agentPreference: agentPreference.value.trim()
  };
  // API Key stored in session storage (cleared when browser closes) for security
  const apiKey = agentApiKey.value.trim();
  if (typeof chrome.storage.session !== 'undefined') {
    chrome.storage.session.set({ agentApiKey: apiKey });
  }
  // Also save to local so the background script can read it
  config.agentApiKey = apiKey;
  chrome.storage.local.set(config, () => {
    showAgentMsg('设置已保存', 'success');
  });
});

btnTestAgent.addEventListener('click', () => {
  showAgentMsg('测试中...', 'success');
  sendToBackground({ type: 'test-agent' }, (resp) => {
    if (!resp) {
      showAgentMsg('通信失败', 'error');
      return;
    }
    if (resp.error) {
      showAgentMsg(`失败: ${resp.error}`, 'error');
    } else {
      showAgentMsg('连接成功!', 'success');
    }
  });
});

// ── Summary / Sessions ──────────────────────────────────────
function formatDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/gm, (match) => {
      if (match.startsWith('<h') || match.startsWith('<ul') || match.startsWith('<li') || match.startsWith('<br') || match.startsWith('</')) return match;
      return match;
    });
}

function loadSessions() {
  sendToBackground({ type: 'get-agent-sessions' }, (resp) => {
    if (!resp) return;

    const { sessions = [], current = null } = resp;
    const allSessions = current ? [current, ...sessions.filter((s) => s.id !== current.id)] : sessions;

    if (allSessions.length === 0 && (!current || current.topics.length === 0)) {
      summaryEmpty.classList.remove('hidden');
      sessionList.innerHTML = '';
      return;
    }

    summaryEmpty.classList.add('hidden');
    sessionList.innerHTML = allSessions.map((s) => renderSessionItem(s, s.id === current?.id)).join('');

    // Bind events
    sessionList.querySelectorAll('.session-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.session-actions')) return;
        const detail = header.nextElementSibling;
        detail.classList.toggle('open');
      });
    });

    sessionList.querySelectorAll('.btn-summary').forEach((btn) => {
      btn.addEventListener('click', () => generateSummary(btn.dataset.id));
    });

    sessionList.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteSession(btn.dataset.id));
    });
  });
}

function renderSessionItem(session, isCurrent) {
  const time = formatDate(session.startTime);
  const count = session.topics.length;
  const label = isCurrent ? '(进行中)' : '';

  const topicHtml = session.topics.map((t) =>
    `<li><a href="${escapeHtml(t.href)}" target="_blank">${escapeHtml(t.title)}</a></li>`
  ).join('');

  const summaryHtml = session.summary
    ? `<div class="session-summary">${renderMarkdown(session.summary)}</div>`
    : '';

  return `
    <div class="session-item">
      <div class="session-header">
        <div class="session-meta">
          <span class="session-time">${time} ${label}</span>
          <span class="session-count">${count} 条</span>
        </div>
        <div class="session-actions">
          ${!isCurrent && count > 0 ? `<button class="btn-sm btn-summary" data-id="${session.id}">总结</button>` : ''}
          ${!isCurrent ? `<button class="btn-sm btn-delete" data-id="${session.id}">删除</button>` : ''}
        </div>
      </div>
      <div class="session-detail">
        ${count > 0 ? `<ul class="session-topics">${topicHtml}</ul>` : '<p style="color:#6c757d">暂无匹配话题</p>'}
        ${summaryHtml}
      </div>
    </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateSummary(sessionId) {
  const btn = sessionList.querySelector(`.btn-summary[data-id="${sessionId}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '生成中...';
  }

  sendToBackground({ type: 'generate-summary', sessionId }, (resp) => {
    if (!resp || resp.error) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '总结';
      }
      alert(resp?.error || '生成总结失败');
      return;
    }
    loadSessions();
  });
}

function deleteSession(sessionId) {
  if (!confirm('确定删除这条记录？')) return;
  sendToBackground({ type: 'delete-session', sessionId }, () => {
    loadSessions();
  });
}
