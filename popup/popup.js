/**
 * Popup script — UI controller for YT Transcript Extractor.
 * Communicates with service-worker.js for all extraction/download logic.
 */

// ============================================================================
// DOM Elements
// ============================================================================

const els = {
  pageStatusIcon: document.getElementById('pageStatusIcon'),
  pageStatusText: document.getElementById('pageStatusText'),
  channelOptions: document.getElementById('channelOptions'),
  urlInput: document.getElementById('urlInput'),
  useCurrentTab: document.getElementById('useCurrentTab'),
  markdownOptions: document.getElementById('markdownOptions'),
  splitConfig: document.getElementById('splitConfig'),
  wordLimit: document.getElementById('wordLimit'),
  concurrency: document.getElementById('concurrency'),
  concurrencyValue: document.getElementById('concurrencyValue'),
  startBtn: document.getElementById('startBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  playlistPickerSection: document.getElementById('playlistPickerSection'),
  loadPlaylistsBtn: document.getElementById('loadPlaylistsBtn'),
  playlistList: document.getElementById('playlistList'),
  progressSection: document.getElementById('progressSection'),
  progressBar: document.getElementById('progressBar'),
  progressPercent: document.getElementById('progressPercent'),
  statSuccess: document.getElementById('statSuccess'),
  statNoTranscript: document.getElementById('statNoTranscript'),
  statFailed: document.getElementById('statFailed'),
  statRemaining: document.getElementById('statRemaining'),
  currentVideoStatus: document.getElementById('currentVideoStatus'),
  pauseBtn: document.getElementById('pauseBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  resultsSection: document.getElementById('resultsSection'),
  resultsSummary: document.getElementById('resultsSummary'),
  downloadBtn: document.getElementById('downloadBtn'),
  errorSection: document.getElementById('errorSection'),
  errorMessage: document.getElementById('errorMessage'),
};

// ============================================================================
// State
// ============================================================================

let currentTabId = null;
let keepAlivePort = null;

// ============================================================================
// Content Script Injection Helper
// ============================================================================

/**
 * Ensure content script is injected into the given tab.
 * If already injected, this is a no-op. If not, injects it programmatically.
 */
async function ensureContentScript(tabId) {
  try {
    // Try to ping the content script
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    if (response && response.pong) return true;
  } catch {
    // Content script not loaded — inject it
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    // Wait a moment for it to initialize
    await new Promise(r => setTimeout(r, 300));
    return true;
  } catch (err) {
    console.warn('Could not inject content script:', err.message);
    return false;
  }
}

/**
 * Safely send a message to a tab's content script, injecting it first if needed.
 */
async function sendToContentScript(tabId, message) {
  await ensureContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // Detect current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    els.urlInput.value = tab.url || '';
    detectPageState(tab);
  }

  // Check for saved progress
  checkSavedProgress();

  // Check if extraction is already in progress
  try {
    chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
      if (chrome.runtime.lastError) return; // service worker not ready
      if (response && response.phase === 'fetching') {
        showProgressUI();
        updateProgress(response.progress);
      } else if (response && response.phase === 'done') {
        showResults(response);
      }
    });
  } catch {
    // Service worker not ready yet
  }

  // Setup keep-alive
  setupKeepAlive();
});

// ============================================================================
// Event Listeners
// ============================================================================

// Mode selection
document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    els.channelOptions.classList.toggle('hidden', e.target.value !== 'channel');
    // Hide playlist picker on manual mode change (it's auto-shown for channel playlists tab)
    els.playlistPickerSection.classList.add('hidden');
  });
});

// Format selection
document.querySelectorAll('input[name="format"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    els.markdownOptions.classList.toggle('hidden', e.target.value !== 'markdown');
  });
});

// Markdown split config
document.querySelectorAll('input[name="mdSplit"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    els.splitConfig.classList.toggle('hidden', e.target.value !== 'split');
  });
});

// Concurrency slider
els.concurrency.addEventListener('input', () => {
  els.concurrencyValue.textContent = els.concurrency.value;
});

// Use current tab URL
els.useCurrentTab.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    els.urlInput.value = tab.url || '';
    detectPageState(tab);
  }
});

// Start button
els.startBtn.addEventListener('click', startExtraction);

// Resume button
els.resumeBtn.addEventListener('click', resumeExtraction);

// Clear history button
els.clearHistoryBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clearSavedProgress' }, () => {
    els.resumeBtn.classList.add('hidden');
    els.clearHistoryBtn.classList.add('hidden');
  });
});

// Load playlists button
els.loadPlaylistsBtn.addEventListener('click', async () => {
  els.loadPlaylistsBtn.disabled = true;
  els.loadPlaylistsBtn.textContent = 'Loading...';
  els.playlistList.classList.add('hidden');
  hideError();

  try {
    const response = await sendToContentScript(currentTabId, { action: 'collectChannelPlaylists' });
    if (!response || !response.success) {
      showError(response?.error || 'Could not load playlists. Make sure you are on a channel\'s Playlists tab.');
      return;
    }
    if (!response.playlists || response.playlists.length === 0) {
      showError('No playlists found on this page.');
      return;
    }
    renderPlaylistList(response.playlists);
  } catch (err) {
    showError('Could not load playlists: ' + err.message);
  } finally {
    els.loadPlaylistsBtn.disabled = false;
    els.loadPlaylistsBtn.textContent = 'Load Playlists';
  }
});

// Pause button
els.pauseBtn.addEventListener('click', () => {
  const isPaused = els.pauseBtn.textContent === 'Pause';
  chrome.runtime.sendMessage({
    action: isPaused ? 'pauseExtraction' : 'resumeExtraction'
  });
  els.pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
});

// Cancel button
els.cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancelExtraction' });
  els.cancelBtn.disabled = true;
  els.cancelBtn.textContent = 'Cancelling...';
});

// Download button (results)
els.downloadBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'generateOutput' });
});

// ============================================================================
// Listen for messages from service worker
// ============================================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'progressUpdate') {
    els.pauseBtn.disabled = false; // Enable pause once fetching phase starts
    updateProgress(message.progress);
  } else if (message.action === 'extractionComplete') {
    showResults(message);
  } else if (message.action === 'extractionError') {
    showError(message.error);
    hideProgressUI();
  } else if (message.action === 'collectionProgress') {
    els.currentVideoStatus.textContent = `Collecting videos... (${message.collected} found)`;
  } else if (message.action === 'currentVideo') {
    els.currentVideoStatus.textContent = message.title
      ? `Processing: ${message.title.substring(0, 45)}...`
      : '';
  }
});

// ============================================================================
// Core Functions
// ============================================================================

async function detectPageState(tab) {
  if (!tab.url || !tab.url.includes('youtube.com')) {
    els.pageStatusIcon.textContent = '⚠';
    els.pageStatusText.textContent = 'Not on YouTube — enter a URL manually';
    return;
  }

  try {
    const response = await sendToContentScript(tab.id, { action: 'getPageState' });
    if (!response) {
      els.pageStatusIcon.textContent = '⚠';
      els.pageStatusText.textContent = 'Page loading... try again';
      return;
    }

    switch (response.type) {
      case 'video':
        els.pageStatusIcon.textContent = '🎬';
        els.pageStatusText.textContent = `Video: ${response.title?.substring(0, 35) || response.videoId}`;
        setMode('single');
        break;
      case 'playlist':
        els.pageStatusIcon.textContent = '📋';
        els.pageStatusText.textContent = `Playlist: ${response.title?.substring(0, 30)}`;
        setMode('playlist');
        break;
      case 'channel':
        els.pageStatusIcon.textContent = '📺';
        if (response.currentTab === 'playlists') {
          els.pageStatusText.textContent = `Channel Playlists: ${response.channelName}`;
          setMode('playlist');
          els.playlistPickerSection.classList.remove('hidden');
        } else {
          els.pageStatusText.textContent = `Channel: ${response.channelName}`;
          setMode('channel');
          els.playlistPickerSection.classList.add('hidden');
        }
        break;
      default:
        els.pageStatusIcon.textContent = '🔗';
        els.pageStatusText.textContent = 'YouTube page detected';
    }
  } catch {
    // Content script could not be loaded — detect from URL only
    detectFromURL(tab.url);
  }
}

function detectFromURL(url) {
  if (/youtube\.com\/watch\?.*v=/.test(url)) {
    els.pageStatusIcon.textContent = '🎬';
    els.pageStatusText.textContent = 'Video detected from URL';
    setMode('single');
  } else if (/youtube\.com\/playlist\?.*list=/.test(url)) {
    els.pageStatusIcon.textContent = '📋';
    els.pageStatusText.textContent = 'Playlist detected from URL';
    setMode('playlist');
  } else if (/youtube\.com\/(@|channel\/|c\/|user\/).*\/playlists/.test(url)) {
    els.pageStatusIcon.textContent = '📺';
    els.pageStatusText.textContent = 'Channel Playlists detected from URL';
    setMode('playlist');
    els.playlistPickerSection.classList.remove('hidden');
  } else if (/youtube\.com\/(@|channel\/|c\/|user\/)/.test(url)) {
    els.pageStatusIcon.textContent = '📺';
    els.pageStatusText.textContent = 'Channel detected from URL';
    setMode('channel');
  } else {
    els.pageStatusIcon.textContent = '🔗';
    els.pageStatusText.textContent = 'YouTube page — select mode manually';
  }
}

function setMode(mode) {
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  els.channelOptions.classList.toggle('hidden', mode !== 'channel');
  // Hide playlist picker when manually switching modes (it's shown programmatically for channel/playlists tab)
}

function renderPlaylistList(playlists) {
  els.playlistList.innerHTML = '';
  playlists.forEach(p => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.innerHTML = `
      <div class="playlist-item-title">${p.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      ${p.videoCount ? `<div class="playlist-item-count">${p.videoCount} videos</div>` : ''}
    `;
    item.addEventListener('click', () => {
      // Deselect all, select this one
      els.playlistList.querySelectorAll('.playlist-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      // Update URL input with this playlist URL
      els.urlInput.value = `https://www.youtube.com/playlist?list=${p.playlistId}`;
      els.pageStatusText.textContent = `Playlist: ${p.title.substring(0, 30)}`;
    });
    els.playlistList.appendChild(item);
  });
  els.playlistList.classList.remove('hidden');
}

function getConfig() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const channelContent = document.querySelector('input[name="channelContent"]:checked').value;
  const format = document.querySelector('input[name="format"]:checked').value;
  const mdSplit = document.querySelector('input[name="mdSplit"]:checked').value;
  const wordLimit = parseInt(els.wordLimit.value) * 1000 || 100000;
  const concurrency = parseInt(els.concurrency.value);
  const url = els.urlInput.value.trim();

  return {
    mode,
    channelContent,
    outputFormat: format,
    markdownMode: mdSplit,
    splitWordLimit: wordLimit,
    concurrency,
    url,
    tabId: currentTabId
  };
}

async function startExtraction() {
  const config = getConfig();

  if (!config.url) {
    showError('Please enter a YouTube URL');
    return;
  }

  // Disable start button
  els.startBtn.disabled = true;
  els.startBtn.textContent = 'Starting...';
  hideError();

  // Ensure content script is ready before starting
  if (currentTabId) {
    const injected = await ensureContentScript(currentTabId);
    if (!injected && config.mode !== 'single') {
      showError('Could not connect to YouTube tab. Please refresh the YouTube page and try again.');
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Download Transcripts';
      return;
    }
  }

  showProgressUI();

  chrome.runtime.sendMessage({ action: 'startExtraction', config }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Service worker not ready. Please close and reopen the extension.');
      hideProgressUI();
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Download Transcripts';
      return;
    }
    if (response && response.error) {
      showError(response.error);
      hideProgressUI();
      els.startBtn.disabled = false;
      els.startBtn.textContent = 'Download Transcripts';
    }
  });
}

async function resumeExtraction() {
  els.resumeBtn.disabled = true;
  els.resumeBtn.textContent = 'Resuming...';
  hideError();
  showProgressUI();

  const config = getConfig();

  chrome.runtime.sendMessage({ action: 'resumeExtraction', config }, (response) => {
    if (chrome.runtime.lastError) {
      showError('Service worker not ready. Please close and reopen the extension.');
      hideProgressUI();
      els.resumeBtn.disabled = false;
      els.resumeBtn.textContent = 'Resume Previous';
      return;
    }
    if (response && response.error) {
      showError(response.error);
      hideProgressUI();
      els.resumeBtn.disabled = false;
      els.resumeBtn.textContent = 'Resume Previous';
    }
  });
}

async function checkSavedProgress() {
  try {
    chrome.runtime.sendMessage({ action: 'checkSavedProgress' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.hasSaved) {
        els.resumeBtn.classList.remove('hidden');
        els.resumeBtn.textContent = `Resume (${response.completed}/${response.total} done)`;
        els.clearHistoryBtn.classList.remove('hidden');
      }
    });
  } catch {
    // Service worker not ready
  }
}

// ============================================================================
// UI Helpers
// ============================================================================

function showProgressUI() {
  els.progressSection.classList.remove('hidden');
  els.resultsSection.classList.add('hidden');
  els.playlistPickerSection.classList.add('hidden');
  els.startBtn.disabled = true;
  els.pauseBtn.textContent = 'Pause';
  els.pauseBtn.disabled = true; // Disabled during collection phase, enabled when fetching starts
  els.cancelBtn.disabled = false;
  els.cancelBtn.textContent = 'Cancel';
}

function hideProgressUI() {
  els.progressSection.classList.add('hidden');
  els.startBtn.disabled = false;
  els.startBtn.textContent = 'Download Transcripts';
}

function updateProgress(progress) {
  if (!progress) return;
  const { total, success, noTranscript, failed, remaining, currentVideo } = progress;
  const completed = success + noTranscript + failed;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  els.progressBar.style.width = `${pct}%`;
  els.progressPercent.textContent = `${pct}% (${completed}/${total})`;
  els.statSuccess.textContent = success;
  els.statNoTranscript.textContent = noTranscript;
  els.statFailed.textContent = failed;
  els.statRemaining.textContent = remaining;

  if (currentVideo) {
    els.currentVideoStatus.textContent = `Processing: ${currentVideo.substring(0, 45)}...`;
  }
}

function showResults(data) {
  els.progressSection.classList.add('hidden');
  els.resultsSection.classList.remove('hidden');
  els.startBtn.disabled = false;
  els.startBtn.textContent = 'Download Transcripts';
  els.resumeBtn.classList.add('hidden');
  els.clearHistoryBtn.classList.add('hidden');

  const p = data.progress || {};
  els.resultsSummary.innerHTML = `
    <div><strong>Total Videos:</strong> ${p.total || 0}</div>
    <div style="color: #66bb6a"><strong>With Transcripts:</strong> ${p.success || 0}</div>
    <div style="color: #ffa726"><strong>No Transcript:</strong> ${p.noTranscript || 0}</div>
    <div style="color: #ef5350"><strong>Failed:</strong> ${p.failed || 0}</div>
  `;
}

function showError(msg) {
  els.errorSection.classList.remove('hidden');
  els.errorMessage.textContent = msg;
}

function hideError() {
  els.errorSection.classList.add('hidden');
}

// ============================================================================
// Keep-alive (prevents service worker suspension during long operations)
// ============================================================================

function setupKeepAlive() {
  try {
    keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    keepAlivePort.onDisconnect.addListener(() => {
      // Reconnect if disconnected
      setTimeout(setupKeepAlive, 1000);
    });
  } catch {
    // Extension context may be invalidated
  }
}
