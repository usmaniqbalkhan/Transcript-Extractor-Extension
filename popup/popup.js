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
  chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
    if (response && response.phase === 'fetching') {
      showProgressUI();
      updateProgress(response.progress);
    } else if (response && response.phase === 'done') {
      showResults(response);
    }
  });

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
    els.urlInput.value = tab.url || '';
    detectPageState(tab);
  }
});

// Start button
els.startBtn.addEventListener('click', startExtraction);

// Resume button
els.resumeBtn.addEventListener('click', resumeExtraction);

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
    updateProgress(message.progress);
  } else if (message.action === 'extractionComplete') {
    showResults(message);
  } else if (message.action === 'extractionError') {
    showError(message.error);
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
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getPageState' });
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
        els.pageStatusText.textContent = `Channel: ${response.channelName}`;
        setMode('channel');
        break;
      default:
        els.pageStatusIcon.textContent = '🔗';
        els.pageStatusText.textContent = 'YouTube page detected';
    }
  } catch {
    els.pageStatusIcon.textContent = '⚠';
    els.pageStatusText.textContent = 'Enter a YouTube URL';
  }
}

function setMode(mode) {
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  els.channelOptions.classList.toggle('hidden', mode !== 'channel');
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

  showProgressUI();

  chrome.runtime.sendMessage({ action: 'startExtraction', config }, (response) => {
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
    if (response && response.error) {
      showError(response.error);
      hideProgressUI();
      els.resumeBtn.disabled = false;
      els.resumeBtn.textContent = 'Resume Previous';
    }
  });
}

async function checkSavedProgress() {
  chrome.runtime.sendMessage({ action: 'checkSavedProgress' }, (response) => {
    if (response && response.hasSaved) {
      els.resumeBtn.classList.remove('hidden');
      els.resumeBtn.textContent = `Resume (${response.completed}/${response.total} done)`;
    }
  });
}

// ============================================================================
// UI Helpers
// ============================================================================

function showProgressUI() {
  els.progressSection.classList.remove('hidden');
  els.resultsSection.classList.add('hidden');
  els.startBtn.disabled = true;
  els.pauseBtn.textContent = 'Pause';
  els.cancelBtn.disabled = false;
  els.cancelBtn.textContent = 'Cancel';
}

function hideProgressUI() {
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
