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
const recordList = document.getElementById('record-list');
const recordEmpty = document.getElementById('record-empty');

const SPEED_LABELS = { 1: '极慢', 2: '慢速', 3: '中速', 4: '快速', 5: '极快' };

let browseTabId = null;
let isStarting = false;

// ── Crypto: AES-GCM encryption for API Key ──────────────────
const CRYPTO_SALT_KEY = 'agentCryptoSalt';

async function getCryptoKey(salt) {
  const enc = new TextEncoder();
  // Derive key from extension ID + salt (device-bound)
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(chrome.runtime.id + salt), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(plaintext) {
  const { [CRYPTO_SALT_KEY]: salt } = await chrome.storage.local.get(CRYPTO_SALT_KEY);
  const actualSalt = salt || crypto.randomUUID();
  if (!salt) await chrome.storage.local.set({ [CRYPTO_SALT_KEY]: actualSalt });

  const key = await getCryptoKey(actualSalt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  // Combine iv + cipher into one hex string
  const combined = new Uint8Array(iv.length + new Uint8Array(cipher).length);
  combined.set(iv);
  combined.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptText(encrypted) {
  try {
    const { [CRYPTO_SALT_KEY]: salt } = await chrome.storage.local.get(CRYPTO_SALT_KEY);
    if (!salt) return encrypted; // Not encrypted yet (legacy)

    const key = await getCryptoKey(salt);
    const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const cipher = data.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return encrypted; // Fallback: treat as plaintext (legacy)
  }
}

// ── Tab Switching ───────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'records') loadBrowseRunSessions();
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
  showTopicInfo(title);

  if (isUnlimited) {
    progressText.textContent = `${safeCurrent} / ∞`;
    progressFill.style.width = '100%';
  } else {
    const safeTotal = Math.max(Number(total) || 0, safeCurrent, 1);
    progressText.textContent = `${safeCurrent} / ${safeTotal}`;
    progressFill.style.width = `${Math.min(100, (safeCurrent / safeTotal) * 100)}%`;
  }
}

function hideProgress() {
  progress.classList.add('hidden');
  progressText.textContent = '';
  progressFill.style.width = '0%';
}

function showTopicInfo(title) {
  if (title) topicTitle.textContent = title;
  if (topicTitle.textContent) topicInfo.classList.remove('hidden');
}

function hideTopicInfo() {
  topicInfo.classList.add('hidden');
  topicTitle.textContent = '';
}

function getActiveTopicProgress(data = {}) {
  const postLimit = Number(data.postLimit) || 0;
  const totalBrowsed = Number(data.totalBrowsed);
  const current = Number(data.current);
  const total = Number(data.total);

  if (postLimit > 0 && Number.isFinite(totalBrowsed)) {
    return {
      current: Math.min(totalBrowsed + 1, postLimit),
      total: postLimit
    };
  }

  if (Number.isFinite(totalBrowsed)) {
    return {
      current: totalBrowsed + 1,
      total: 0
    };
  }

  if (total > 0 && Number.isFinite(current)) {
    return {
      current: Math.min(current + 1, total),
      total
    };
  }

  return null;
}

function showActiveTopicProgress(data = {}) {
  const progressData = getActiveTopicProgress(data);
  showTopicInfo(data.title);

  if (!progressData) {
    hideProgress();
    return;
  }

  showProgress(progressData.current, progressData.total, data.title);
}

function setActiveTopicStatus(data = {}) {
  const progressData = getActiveTopicProgress(data);

  if (progressData?.total > 0) {
    setStatus(`浏览帖子 (${progressData.current}/${progressData.total})`, 'running');
    return;
  }

  if (progressData) {
    setStatus(`浏览帖子 ${progressData.current} / ∞`, 'running');
    return;
  }

  setStatus('浏览帖子', 'running');
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
    hideProgress();
    hideTopicInfo();
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
      hideProgress();
      hideTopicInfo();
      setStatus('启动中...', 'running');
      break;
    case 'resuming':
      updateUI(true);
      hideProgress();
      hideTopicInfo();
      setStatus('恢复中...', 'running');
      break;
    case 'browsing':
      updateUI(true);
      hideProgress();
      showTopicInfo(data.title);
      setStatus('打开帖子中...', 'running');
      break;
    case 'on-topic':
      updateUI(true);
      setActiveTopicStatus(data);
      showActiveTopicProgress(data);
      break;
    case 'next-page':
      updateUI(true);
      hideProgress();
      hideTopicInfo();
      setStatus('翻页中...', 'running');
      break;
    case 'topic-error':
      updateUI(true);
      setStatus('跳过失败帖子', 'running');
      showActiveTopicProgress(data);
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
      hideProgress();
      hideTopicInfo();
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

  if (changes.currentBrowseRunSnapshot || changes.browseRunSessions) {
    const recordsTab = document.getElementById('tab-records');
    if (recordsTab?.classList.contains('active')) loadBrowseRunSessions();
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
    agentModel.value = result.agentModel || '';
    agentPreference.value = result.agentPreference || '';

    // Decrypt API key
    if (result.agentApiKey) {
      decryptText(result.agentApiKey).then((decrypted) => {
        agentApiKey.value = decrypted;
      });
    }

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

btnSaveAgent.addEventListener('click', async () => {
  const apiKeyRaw = agentApiKey.value.trim();
  const encryptedKey = apiKeyRaw ? await encryptText(apiKeyRaw) : '';

  const config = {
    agentBaseUrl: agentBaseUrl.value.trim(),
    agentApiKey: encryptedKey,
    agentModel: agentModel.value.trim(),
    agentPreference: agentPreference.value.trim()
  };
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

// ── Browse Records ──────────────────────────────────────────
function loadBrowseRunSessions() {
  sendToBackground({ type: 'get-browse-run-sessions' }, (resp) => {
    if (!resp) return;

    const { sessions = [], current = null } = resp;
    const allSessions = current ? [current, ...sessions.filter((s) => s.id !== current.id)] : sessions;

    if (allSessions.length === 0 && (!current || current.topics.length === 0)) {
      recordEmpty.classList.remove('hidden');
      recordList.innerHTML = '';
      return;
    }

    recordEmpty.classList.add('hidden');
    recordList.innerHTML = allSessions.map((s) => renderBrowseRunItem(s, s.id === current?.id)).join('');

    recordList.querySelectorAll('.session-header').forEach((header) => {
      header.addEventListener('click', () => {
        const detail = header.nextElementSibling;
        detail.classList.toggle('open');
      });
    });
  });
}

function renderBrowseRunItem(run, isCurrent) {
  const time = formatDate(run.startTime);
  const count = run.topics.length;
  const label = isCurrent || run.status === 'running' ? '(进行中)' : '';
  const endText = run.endTime ? `结束 ${formatDate(run.endTime)}` : '运行中';

  const topicHtml = run.topics.map((t) =>
    `<li><a href="${escapeHtml(t.href)}" target="_blank">${escapeHtml(t.title)}</a></li>`
  ).join('');

  return `
    <div class="session-item">
      <div class="session-header">
        <div class="session-meta">
          <span class="session-time">${time} ${label}</span>
          <span class="session-count">${count} 条</span>
        </div>
        <div class="session-actions">
          <span class="session-state">${endText}</span>
        </div>
      </div>
      <div class="session-detail">
        ${count > 0 ? `<ul class="session-topics">${topicHtml}</ul>` : '<p style="color:#6c757d">暂无刷帖记录</p>'}
      </div>
    </div>`;
}

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
