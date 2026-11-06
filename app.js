'use strict';

const $ = selector => document.querySelector(selector);
const scanForm = $('#scanForm');
const scanButton = $('#scanButton');
const siteUrl = $('#siteUrl');
const allowHttp = $('#allowHttp');
const scanMode = $('#scanMode');
const crawlDepth = $('#crawlDepth');
const maxPages = $('#maxPages');
const maxResourcesInput = $('#maxResources');
const scanMessage = $('#scanMessage');
const resourceRows = $('#resourceRows');
const resourceCount = $('#resourceCount');
const selectedCount = $('#selectedCount');
const downloadButton = $('#downloadButton');
const categoryFilter = $('#categoryFilter');
const selectAll = $('#selectAll');
const clearAll = $('#clearAll');
const activityPanel = $('#activityPanel');
const activityLabel = $('#activityLabel');
const activityPercent = $('#activityPercent');
const activityFill = $('#activityFill');
const activityDetail = $('#activityDetail');
const zipProgress = $('#zipProgress');
const zipProgressLabel = $('#zipProgressLabel');
const zipProgressPercent = $('#zipProgressPercent');
const zipProgressFill = $('#zipProgressFill');
const zipProgressDetail = $('#zipProgressDetail');
let zipProgressActive = false;
let progressTimer = null;

function newProgressId() {
  return `wx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function showProgress(data, running = true) {
  activityPanel.hidden = false;
  activityPanel.classList.toggle('is-running', running && data.percent < 100);
  activityLabel.textContent = data.label || 'Working…';
  activityPercent.textContent = `${data.percent || 0}%`;
  activityFill.style.width = `${Math.max(0, Math.min(100, data.percent || 0))}%`;
  activityDetail.textContent = data.detail || '';
  if (zipProgressActive) {
    zipProgress.hidden = false;
    zipProgressLabel.textContent = data.label || 'Preparing ZIP';
    zipProgressPercent.textContent = `${data.percent || 0}%`;
    zipProgressFill.style.width = `${Math.max(0, Math.min(100, data.percent || 0))}%`;
    zipProgressDetail.textContent = data.detail || '';
  }
}

function startProgressPolling(id) {
  if (progressTimer) clearInterval(progressTimer);
  showProgress({ percent: 1, label: 'Starting…', detail: 'Waiting for local server' });
  progressTimer = setInterval(async () => {
    try {
      const response = await fetch(`/progress?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (response.ok) showProgress(await response.json());
    } catch {}
  }, 350);
}

function stopProgressPolling() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
  activityPanel.classList.remove('is-running');
}

let resources = [];
let selected = new Set();

async function checkHealth() {
  const dot = $('#healthDot');
  const text = $('#healthText');
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) throw new Error('Server unavailable');
    const data = await response.json();
    dot.className = 'dot online';
    text.textContent = `LOCAL SERVER ONLINE · V${data.version}`;
  } catch {
    dot.className = 'dot offline';
    text.textContent = 'LOCAL SERVER OFFLINE';
  }
}

function setMessage(message, type = '') {
  scanMessage.textContent = message;
  scanMessage.className = `message ${type}`.trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function visibleResources() {
  const filter = categoryFilter.value;
  return resources.filter(item =>
    filter === 'all' || item.category === filter
  );
}

function updateSelection() {
  selectedCount.textContent = `${selected.size} selected`;
  downloadButton.disabled = selected.size === 0;
  selectAll.disabled = resources.every(item => item.status.startsWith('Blocked:')) || resources.length === 0;
  clearAll.disabled = selected.size === 0;
}

function renderRows() {
  const visible = visibleResources();
  resourceCount.textContent = `${resources.length} resource${resources.length === 1 ? '' : 's'}`;
  if (!visible.length) {
    resourceRows.innerHTML = `<tr class="empty-row"><td colspan="5">${resources.length ? 'No resources in this category.' : 'Your scan results will appear here.'}</td></tr>`;
    updateSelection();
    return;
  }
  resourceRows.innerHTML = visible.map(item => {
    const blocked = item.status.startsWith('Blocked:');
    return `<tr>
      <td><input type="checkbox" data-id="${item.id}" aria-label="Select ${escapeHtml(item.filename)}" ${selected.has(item.id) ? 'checked' : ''} ${blocked ? 'disabled' : ''}></td>
      <td><span class="resource-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span><span class="resource-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span></td>
      <td><span class="type-pill">${escapeHtml(item.category)}</span></td>
      <td>${escapeHtml(item.host)}</td>
      <td><span class="status ${blocked ? 'blocked' : ''}">${escapeHtml(item.status)}</span></td>
    </tr>`;
  }).join('');
  updateSelection();
}

function updateCategories() {
  const current = categoryFilter.value;
  const categories = [
    'Audio', 'Binary / data', 'Data', 'Document', 'Font', 'Game / app data',
    'HTML', 'Image', 'JavaScript', 'JSON / data', 'Other', 'Source map',
    'Stylesheet', 'Text', 'Video', 'WebAssembly', 'XML / data'
  ];
  categoryFilter.innerHTML = '<option value="all">All known file types</option>' +
    categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  categoryFilter.value = categories.includes(current) ? current : 'all';
}

scanForm.addEventListener('submit', async event => {
  event.preventDefault();
  const url = siteUrl.value.trim();
  if (!url) return;
  const depthValue = Math.max(0, Math.min(5, Number(crawlDepth.value) || 0));
  const pagesValue = Math.max(1, Math.min(100, Number(maxPages.value) || 20));
  const resourcesValue = Math.max(1, Math.min(600, Number(maxResourcesInput.value) || 300));
  crawlDepth.value = depthValue;
  maxPages.value = pagesValue;
  maxResourcesInput.value = resourcesValue;
  scanButton.disabled = true;
  scanButton.innerHTML = '<span>Scanning…</span><span aria-hidden="true">◌</span>';
  setMessage('Validating the public destination and scanning the page HTML…');
  resources = [];
  selected.clear();
  updateCategories();
  renderRows();
  const progressId = newProgressId();
  startProgressPolling(progressId);

  try {
    const endpoint = scanMode.value === 'browser' ? '/browser-scan' : '/scan';
    if (scanMode.value === 'browser') setMessage('Launching optional headless browser; collecting runtime requests and lazy-loaded resources…');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Progress-ID': progressId },
      body: JSON.stringify({ url, allowHttp: allowHttp.checked, depth: depthValue, maxPages: pagesValue, maxResources: resourcesValue })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Scan failed.');
    resources = data.resources || [];
    selected = new Set(resources.filter(item => !item.status.startsWith('Blocked:')).map(item => item.id));
    updateCategories();
    renderRows();
    setMessage(`Scan complete. Visited ${data.pagesVisited || 1} pages and discovered ${resources.length} resources.${data.errors?.length ? ` ${data.errors.length} page(s) could not be read.` : ''} ${data.note || ''}`, 'success');
    showProgress({ percent: 100, label: 'Scan complete', detail: `${data.pagesVisited || 1} pages · ${resources.length} resources` }, false);
  } catch (error) {
    setMessage(error.message || 'Scan failed.', 'error');
    showProgress({ percent: 100, label: 'Scan failed', detail: error.message || 'Unknown error' }, false);
    renderRows();
  } finally {
    stopProgressPolling();
    scanButton.disabled = false;
    scanButton.innerHTML = '<span>Scan website</span><span aria-hidden="true">↗</span>';
  }
});

resourceRows.addEventListener('change', event => {
  const checkbox = event.target.closest('input[data-id]');
  if (!checkbox) return;
  const id = Number(checkbox.dataset.id);
  if (checkbox.checked) selected.add(id);
  else selected.delete(id);
  updateSelection();
});

categoryFilter.addEventListener('change', renderRows);

selectAll.addEventListener('click', () => {
  for (const item of resources) {
    if (!item.status.startsWith('Blocked:')) selected.add(item.id);
  }
  renderRows();
});

clearAll.addEventListener('click', () => {
  selected.clear();
  renderRows();
});

downloadButton.addEventListener('click', async () => {
  const urls = resources.filter(item => selected.has(item.id)).map(item => item.url);
  if (!urls.length) return;
  downloadButton.disabled = true;
  downloadButton.textContent = 'Preparing ZIP…';
  zipProgressActive = true;
  zipProgress.hidden = false;
  zipProgressLabel.textContent = 'Starting ZIP preparation';
  zipProgressPercent.textContent = '0%';
  zipProgressFill.style.width = '0%';
  zipProgressDetail.textContent = `0 of ${urls.length} files fetched`;
  const progressId = newProgressId();
  startProgressPolling(progressId);
  setMessage(`Fetching ${urls.length} selected resource(s), then building the ZIP archive…`);
  try {
    const response = await fetch('/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Progress-ID': progressId },
      body: JSON.stringify({ urls, allowHttp: allowHttp.checked })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'ZIP download failed.');
    }
    // Server-side ZIP work is complete; switch from polling to browser transfer progress.
    stopProgressPolling();
    const totalHeader = Number(response.headers.get('content-length')) || 0;
    let received = 0;
    const chunks = [];
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const pct = totalHeader ? Math.min(100, Math.round(received / totalHeader * 100)) : 0;
        showProgress({
          percent: 97 + Math.round(pct * 0.03),
          label: 'Downloading ZIP to your device',
          detail: totalHeader
            ? `${(received / 1024 / 1024).toFixed(1)} of ${(totalHeader / 1024 / 1024).toFixed(1)} MB transferred`
            : `${(received / 1024 / 1024).toFixed(1)} MB transferred`
        });
      }
    } else {
      const fallback = await response.blob();
      chunks.push(fallback);
      received = fallback.size;
    }
    const blob = new Blob(chunks, { type: 'application/zip' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'webxtract-resources.zip';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    setMessage(`ZIP archive created successfully from ${urls.length} selected resource(s).`, 'success');
    showProgress({ percent: 100, label: 'ZIP ready', detail: `${urls.length} selected resources packaged · ${(blob.size / 1024 / 1024).toFixed(1)} MB` }, false);
  } catch (error) {
    setMessage(error.message || 'ZIP download failed.', 'error');
    showProgress({ percent: 100, label: 'ZIP failed', detail: error.message || 'Unknown error' }, false);
  } finally {
    stopProgressPolling();
    zipProgressActive = false;
    downloadButton.disabled = selected.size === 0;
    downloadButton.innerHTML = 'Download selected ZIP <span aria-hidden="true">↓</span>';
  }
});

checkHealth();
