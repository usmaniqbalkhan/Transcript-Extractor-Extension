/**
 * Service Worker — Core orchestration for YT Transcript Extractor.
 * Manages transcript extraction, batch processing, progress, and output generation.
 */

// ============================================================================
// State
// ============================================================================

let state = {
  phase: 'idle',        // idle | collecting | fetching | done | error
  mode: null,           // single | playlist | channel
  channelContent: null, // videos | shorts | both
  outputFormat: null,   // markdown | srt
  markdownMode: null,   // single | split
  splitWordLimit: 100000,
  concurrency: 3,
  videos: [],
  results: [],
  progress: {
    total: 0,
    success: 0,
    noTranscript: 0,
    failed: 0,
    remaining: 0,
    currentVideo: null
  },
  isPaused: false,
  isCancelled: false,
  tabId: null,
  sourceName: ''
};

// ============================================================================
// Keep-alive
// ============================================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    const interval = setInterval(() => {
      try { port.postMessage({ ping: true }); } catch { clearInterval(interval); }
    }, 25000);
    port.onDisconnect.addListener(() => clearInterval(interval));
  }
});

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  switch (action) {
    case 'startExtraction':
      handleStart(message.config).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'pauseExtraction':
      state.isPaused = true;
      sendResponse({ success: true });
      return false;

    case 'resumeExtraction':
      if (message.config) {
        handleResume(message.config).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
        return true;
      }
      state.isPaused = false;
      sendResponse({ success: true });
      return false;

    case 'cancelExtraction':
      state.isCancelled = true;
      state.isPaused = false;
      sendResponse({ success: true });
      return false;

    case 'getState':
      sendResponse({ phase: state.phase, progress: state.progress });
      return false;

    case 'generateOutput':
      generateAndDownloadOutput().then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'checkSavedProgress':
      checkSaved().then(r => sendResponse(r));
      return true;

    case 'clearSavedProgress':
      chrome.storage.local.remove('savedState');
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// ============================================================================
// Start Extraction
// ============================================================================

async function handleStart(config) {
  // Reset state
  state = {
    phase: 'collecting',
    mode: config.mode,
    channelContent: config.channelContent,
    outputFormat: config.outputFormat,
    markdownMode: config.markdownMode,
    splitWordLimit: config.splitWordLimit || 100000,
    concurrency: config.concurrency || 3,
    videos: [],
    results: [],
    progress: { total: 0, success: 0, noTranscript: 0, failed: 0, remaining: 0, currentVideo: null },
    isPaused: false,
    isCancelled: false,
    tabId: config.tabId,
    sourceName: ''
  };

  try {
    // Step 1: Collect videos
    const videos = await collectVideos(config);
    if (!videos || videos.length === 0) {
      throw new Error('No videos found');
    }

    state.videos = videos;
    state.progress.total = videos.length;
    state.progress.remaining = videos.length;
    state.phase = 'fetching';

    broadcastProgress();

    // Step 2: Extract transcripts
    await runBatchExtraction(videos, config.tabId, state.concurrency);

    // Save progress
    await saveProgress();

    state.phase = 'done';
    safeBroadcast({
      action: 'extractionComplete',
      progress: state.progress
    });

    // Auto-generate output
    await generateAndDownloadOutput();

    return { success: true };
  } catch (err) {
    state.phase = 'error';
    safeBroadcast({ action: 'extractionError', error: err.message });
    return { error: err.message };
  }
}

// ============================================================================
// Resume Extraction
// ============================================================================

async function handleResume(config) {
  const saved = await loadSavedProgress();
  if (!saved) {
    throw new Error('No saved progress found');
  }

  state = {
    ...state,
    phase: 'fetching',
    mode: saved.mode || config.mode,
    channelContent: config.channelContent,
    outputFormat: config.outputFormat,
    markdownMode: config.markdownMode,
    splitWordLimit: config.splitWordLimit || 100000,
    concurrency: config.concurrency || 3,
    videos: saved.videos,
    results: saved.results || [],
    isPaused: false,
    isCancelled: false,
    tabId: config.tabId,
    sourceName: saved.sourceName || ''
  };

  const completedIds = new Set(state.results.map(r => r.videoId));
  const remaining = state.videos.filter(v => !completedIds.has(v.videoId));

  state.progress = {
    total: state.videos.length,
    success: state.results.filter(r => r.status === 'success').length,
    noTranscript: state.results.filter(r => r.status === 'no_transcript').length,
    failed: state.results.filter(r => r.status === 'failed').length,
    remaining: remaining.length,
    currentVideo: null
  };

  broadcastProgress();

  if (remaining.length === 0) {
    state.phase = 'done';
    chrome.runtime.sendMessage({ action: 'extractionComplete', progress: state.progress });
    return { success: true };
  }

  try {
    await runBatchExtraction(remaining, config.tabId, state.concurrency);
    await saveProgress();
    state.phase = 'done';
    chrome.runtime.sendMessage({ action: 'extractionComplete', progress: state.progress });
    await generateAndDownloadOutput();
    return { success: true };
  } catch (err) {
    state.phase = 'error';
    safeBroadcast({ action: 'extractionError', error: err.message });
    return { error: err.message };
  }
}

// ============================================================================
// Video Collection
// ============================================================================

async function collectVideos(config) {
  const { mode, url, tabId, channelContent } = config;

  if (mode === 'single') {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');
    const title = await getVideoTitle(tabId, videoId);
    state.sourceName = sanitizeFilename(title || videoId);
    return [{ videoId, title: title || videoId }];
  }

  // For playlist/channel, ensure content script is injected first
  await ensureContentScriptInjected(tabId);

  if (mode === 'playlist') {
    const response = await safeSendToTab(tabId, { action: 'collectPlaylistVideos' });
    if (!response || !response.success) throw new Error(response?.error || 'Failed to collect playlist videos');
    state.sourceName = sanitizeFilename(await getPlaylistTitle(tabId) || 'playlist');
    return response.videos;
  }

  if (mode === 'channel') {
    let allVideos = [];
    const channelName = await getChannelName(tabId);
    state.sourceName = sanitizeFilename(channelName || 'channel');

    if (channelContent === 'videos' || channelContent === 'both') {
      const resp = await safeSendToTab(tabId, { action: 'collectChannelVideos', tabName: 'videos' });
      if (resp && resp.success) allVideos.push(...resp.videos);
    }

    if (channelContent === 'shorts' || channelContent === 'both') {
      // Small delay between tab navigations
      if (channelContent === 'both') await sleep(2000);
      // Re-inject content script after navigation to new tab
      await ensureContentScriptInjected(tabId);
      const resp = await safeSendToTab(tabId, { action: 'collectChannelVideos', tabName: 'shorts' });
      if (resp && resp.success) allVideos.push(...resp.videos);
    }

    if (allVideos.length === 0) throw new Error('No videos found on channel');
    return allVideos;
  }

  throw new Error('Invalid mode');
}

/**
 * Ensure content script is loaded in the tab. Injects if not present.
 */
async function ensureContentScriptInjected(tabId) {
  try {
    const response = await safeSendToTab(tabId, { action: 'ping' });
    if (response && response.pong) return;
  } catch {
    // Not loaded
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    await sleep(500);
  } catch (err) {
    throw new Error('Could not connect to YouTube tab. Please refresh the page and try again.');
  }
}

/**
 * Safely send message to tab, returning null on error instead of throwing.
 */
function safeSendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

// ============================================================================
// Batch Transcript Extraction
// ============================================================================

async function runBatchExtraction(videos, tabId, concurrency) {
  const queue = [...videos];
  const workers = [];

  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(workerLoop(queue, tabId));
  }

  await Promise.all(workers);
}

async function workerLoop(queue, tabId) {
  while (queue.length > 0 && !state.isCancelled) {
    // Handle pause
    while (state.isPaused && !state.isCancelled) {
      await sleep(500);
    }
    if (state.isCancelled) break;

    const video = queue.shift();
    if (!video) break;

    state.progress.currentVideo = video.title;
    safeBroadcast({ action: 'currentVideo', title: video.title });

    try {
      const result = await extractTranscriptInMainWorld(tabId, video.videoId);

      if (result && result.segments && result.segments.length > 0) {
        const fullText = result.segments.map(s => decodeHTMLEntities(s.text)).join(' ');
        state.results.push({
          videoId: video.videoId,
          title: video.title,
          transcript: fullText,
          segments: result.segments,
          language: result.language || 'Unknown',
          status: 'success'
        });
        state.progress.success++;
      } else if (result && result.noTranscript) {
        state.results.push({
          videoId: video.videoId,
          title: video.title,
          transcript: null,
          segments: null,
          language: null,
          status: 'no_transcript'
        });
        state.progress.noTranscript++;
      } else {
        state.results.push({
          videoId: video.videoId,
          title: video.title,
          transcript: null,
          segments: null,
          language: null,
          status: 'failed',
          error: result?.error || 'Unknown error'
        });
        state.progress.failed++;
      }
    } catch (err) {
      state.results.push({
        videoId: video.videoId,
        title: video.title,
        transcript: null,
        segments: null,
        language: null,
        status: 'failed',
        error: err.message
      });
      state.progress.failed++;
    }

    state.progress.remaining = queue.length;
    broadcastProgress();

    // Save progress periodically (every 5 videos)
    if (state.results.length % 5 === 0) {
      await saveProgress();
    }

    // Throttle to avoid rate limiting
    await sleep(800 + Math.random() * 400);
  }
}

// ============================================================================
// Transcript Extraction (Main World)
// ============================================================================

async function extractTranscriptInMainWorld(tabId, videoId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: mainWorldExtractTranscript,
      args: [videoId]
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return { noTranscript: true };
  } catch (err) {
    return { error: err.message, noTranscript: false };
  }
}

/**
 * This function runs in the MAIN world (YouTube's page context).
 * It has access to same-origin fetch for YouTube APIs.
 */
async function mainWorldExtractTranscript(videoId) {
  try {
    // Method 1: InnerTube player API
    let captionTracks = null;

    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: videoId,
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240101.00.00',
              hl: 'en',
              gl: 'US'
            }
          }
        })
      });

      const data = await response.json();
      captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    } catch {
      // Fall through to method 2
    }

    // Method 2: Parse video page HTML
    if (!captionTracks || captionTracks.length === 0) {
      try {
        const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        const html = await pageResp.text();
        const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (match) {
          const playerResp = JSON.parse(match[1]);
          captionTracks = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        }
      } catch {
        // No captions available
      }
    }

    if (!captionTracks || captionTracks.length === 0) {
      return { noTranscript: true };
    }

    // Select best caption track (matching Python tool's language priority)
    // 1. Manual English  2. Auto English  3. Translated to English  4. Any
    function pickTrack(tracks) {
      let t = tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr');
      if (t) return { track: t, method: 'english' };
      t = tracks.find(t => t.languageCode?.startsWith('en') && t.kind === 'asr');
      if (t) return { track: t, method: 'english-auto' };
      t = tracks.find(t => t.isTranslatable !== false);
      if (t) return { track: t, method: 'translated', tlang: 'en' };
      if (tracks.length > 0) return { track: tracks[0], method: 'original' };
      return null;
    }

    const selected = pickTrack(captionTracks);
    if (!selected) {
      return { noTranscript: true };
    }

    const { track, method, tlang } = selected;
    let baseUrl = track.baseUrl;

    // Add translation language if needed
    if (tlang) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      baseUrl += `${sep}tlang=${tlang}`;
    }

    // Fetch transcript in json3 format
    const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    let segments = [];

    try {
      const resp = await fetch(json3Url);
      const data = await resp.json();

      if (data.events) {
        for (const event of data.events) {
          if (event.segs) {
            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (text && text !== '\n') {
              segments.push({
                start: (event.tStartMs || 0) / 1000,
                duration: (event.dDurationMs || 0) / 1000,
                text: text
              });
            }
          }
        }
      }
    } catch {
      // Fallback: try XML format
      try {
        const xmlUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=srv3';
        const resp = await fetch(xmlUrl);
        const xml = await resp.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'text/xml');
        const textNodes = doc.querySelectorAll('text, p');

        textNodes.forEach(node => {
          const text = node.textContent.trim();
          if (text) {
            segments.push({
              start: parseFloat(node.getAttribute('start') || node.getAttribute('t') || 0) / (node.getAttribute('t') ? 1000 : 1),
              duration: parseFloat(node.getAttribute('dur') || node.getAttribute('d') || 0) / (node.getAttribute('d') ? 1000 : 1),
              text: text
            });
          }
        });
      } catch {
        return { noTranscript: true };
      }
    }

    if (segments.length === 0) {
      return { noTranscript: true };
    }

    // Build language info string
    let language = track.name?.simpleText || track.languageCode || 'Unknown';
    if (method === 'english') {
      const isAuto = track.kind === 'asr';
      language = `English (${isAuto ? 'auto-generated' : 'manual'})`;
    } else if (method === 'english-auto') {
      language = 'English (auto-generated)';
    } else if (method === 'translated') {
      language = `Translated from ${track.name?.simpleText || track.languageCode}`;
    } else if (method === 'original') {
      language = `${track.name?.simpleText || track.languageCode} (no English available)`;
    }

    return { segments, language };

  } catch (err) {
    return { error: err.message, noTranscript: false };
  }
}


// ============================================================================
// Output Generation & Download
// ============================================================================

async function generateAndDownloadOutput() {
  const results = state.results;
  const sourceName = state.sourceName || 'transcripts';
  const format = state.outputFormat;
  const mdMode = state.markdownMode;
  const wordLimit = state.splitWordLimit;

  if (format === 'srt') {
    await generateSRTOutput(results, sourceName);
  } else {
    if (mdMode === 'split') {
      await generateSplitMarkdownOutput(results, sourceName, wordLimit);
    } else {
      await generateSingleMarkdownOutput(results, sourceName);
    }
  }

  // Clear saved progress after successful download
  await chrome.storage.local.remove('savedState');
}

async function generateSingleMarkdownOutput(results, sourceName) {
  const content = formatMarkdown(results, sourceName, state.mode);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = sanitizeFilename(sourceName) + '.md';

  await chrome.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function generateSplitMarkdownOutput(results, sourceName, wordLimit) {
  const successResults = results.filter(r => r.status === 'success');
  const files = [];
  let currentVideos = [];
  let currentWordCount = 0;
  let partNumber = 1;

  for (const result of successResults) {
    const videoWords = result.transcript ? result.transcript.split(/\s+/).length : 0;

    if (currentVideos.length > 0 && (currentWordCount + videoWords) > wordLimit) {
      const content = formatMarkdown(currentVideos, sourceName, state.mode);
      files.push({ name: `${sanitizeFilename(sourceName)}_part${partNumber}.md`, content });
      partNumber++;
      currentVideos = [result];
      currentWordCount = videoWords;
    } else {
      currentVideos.push(result);
      currentWordCount += videoWords;
    }
  }

  if (currentVideos.length > 0) {
    const content = formatMarkdown(currentVideos, sourceName, state.mode);
    files.push({ name: `${sanitizeFilename(sourceName)}_part${partNumber}.md`, content });
  }

  if (files.length === 1) {
    // Single file, no need for ZIP
    const blob = new Blob([files[0].content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: files[0].name, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } else {
    await downloadAsZip(files, `${sanitizeFilename(sourceName)}_transcripts.zip`);
  }
}

async function generateSRTOutput(results, sourceName) {
  const successResults = results.filter(r => r.status === 'success' && r.segments);

  if (successResults.length === 1) {
    // Single SRT file
    const content = formatSRT(successResults[0].segments);
    const blob = new Blob([content], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const filename = sanitizeFilename(successResults[0].title || sourceName) + '.srt';
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } else {
    // Multiple SRT files in ZIP
    const files = successResults.map(r => ({
      name: sanitizeFilename(r.title || r.videoId) + '.srt',
      content: formatSRT(r.segments)
    }));
    await downloadAsZip(files, `${sanitizeFilename(sourceName)}_subtitles.zip`);
  }
}

// ============================================================================
// Markdown Formatter (matches Python tool's exact format)
// ============================================================================

function formatMarkdown(results, sourceName, sourceType) {
  const lines = [];
  const allResults = Array.isArray(results) ? results : [];
  const videosWithTranscript = allResults.filter(r => r.status === 'success').length;
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  lines.push(`# ${sourceName}`);
  lines.push('');
  lines.push(`**Source Type:** ${(sourceType || 'video').charAt(0).toUpperCase() + (sourceType || 'video').slice(1)}`);
  lines.push(`**Total Videos:** ${allResults.length}`);
  lines.push(`**Videos with Transcripts:** ${videosWithTranscript}`);
  lines.push(`**Downloaded:** ${dateStr}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Table of Contents
  lines.push('## Table of Contents');
  lines.push('');
  let tocIndex = 1;
  for (const video of allResults) {
    if (video.status === 'success' && video.transcript) {
      const anchor = (video.title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
      lines.push(`${tocIndex}. [${video.title}](#${anchor})`);
      tocIndex++;
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Video sections
  let videoIndex = 1;
  for (const video of allResults) {
    lines.push(`## ${videoIndex}. ${video.title || 'Unknown'}`);
    lines.push('');
    lines.push(`**Video ID:** ${video.videoId}`);
    lines.push(`**URL:** https://www.youtube.com/watch?v=${video.videoId}`);
    if (video.language) {
      lines.push(`**Transcript Language:** ${video.language}`);
    }
    lines.push('');

    if (video.status === 'success' && video.transcript) {
      lines.push('### Transcript');
      lines.push('');
      lines.push(video.transcript);
    } else {
      lines.push('*No transcript available for this video.*');
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    videoIndex++;
  }

  return lines.join('\n');
}

// ============================================================================
// SRT Formatter
// ============================================================================

function formatSRT(segments) {
  if (!segments || segments.length === 0) return '';

  return segments.map((seg, i) => {
    const startTime = formatSRTTimestamp(seg.start);
    const endTime = formatSRTTimestamp(seg.start + seg.duration);
    const text = decodeHTMLEntities(seg.text);
    return `${i + 1}\n${startTime} --> ${endTime}\n${text}\n`;
  }).join('\n');
}

function formatSRTTimestamp(seconds) {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ============================================================================
// ZIP Download (inline minimal ZIP for cases without JSZip)
// ============================================================================

async function downloadAsZip(files, zipFilename) {
  // Try to use JSZip if available
  try {
    if (typeof JSZip !== 'undefined') {
      const zip = new JSZip();
      for (const file of files) {
        zip.file(file.name, file.content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename: zipFilename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    }
  } catch {
    // Fall through to manual ZIP
  }

  // Minimal ZIP implementation for service worker context
  const encoder = new TextEncoder();
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const data = encoder.encode(file.content);
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(data);

    // Local file header
    const header = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);   // signature
    hv.setUint16(4, 20, true);            // version needed
    hv.setUint16(6, 0, true);             // flags
    hv.setUint16(8, 0, true);             // compression (store)
    hv.setUint16(10, 0, true);            // mod time
    hv.setUint16(12, 0, true);            // mod date
    hv.setUint32(14, crc, true);          // crc32
    hv.setUint32(18, data.length, true);  // compressed size
    hv.setUint32(22, data.length, true);  // uncompressed size
    hv.setUint16(26, nameBytes.length, true); // name length
    hv.setUint16(28, 0, true);            // extra length
    header.set(nameBytes, 30);

    entries.push({ header, data, nameBytes, crc, offset });
    offset += header.length + data.length;
  }

  // Central directory
  const cdParts = [];
  let cdSize = 0;
  for (const entry of entries) {
    const cd = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0x20, true);
    cv.setUint32(42, entry.offset, true);
    cd.set(entry.nameBytes, 46);
    cdParts.push(cd);
    cdSize += cd.length;
  }

  // End of central directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  // Combine all parts
  const totalSize = offset + cdSize + 22;
  const zipData = new Uint8Array(totalSize);
  let pos = 0;

  for (const entry of entries) {
    zipData.set(entry.header, pos);
    pos += entry.header.length;
    zipData.set(entry.data, pos);
    pos += entry.data.length;
  }

  for (const cd of cdParts) {
    zipData.set(cd, pos);
    pos += cd.length;
  }

  zipData.set(eocd, pos);

  const blob = new Blob([zipData], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: zipFilename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Simple CRC32 implementation
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// Progress Save/Load
// ============================================================================

async function saveProgress() {
  // Strip non-serializable fields (segments can be large, keep them for SRT)
  const saveResults = state.results.map(r => ({
    videoId: r.videoId,
    title: r.title,
    transcript: r.transcript,
    segments: r.segments,
    language: r.language,
    status: r.status,
    error: r.error
  }));

  await chrome.storage.local.set({
    savedState: {
      mode: state.mode,
      sourceName: state.sourceName,
      videos: state.videos,
      results: saveResults,
      progress: state.progress,
      timestamp: Date.now()
    }
  });
}

async function loadSavedProgress() {
  const { savedState } = await chrome.storage.local.get('savedState');
  if (savedState && (Date.now() - savedState.timestamp) < 86400000) {
    return savedState;
  }
  return null;
}

async function checkSaved() {
  const saved = await loadSavedProgress();
  if (saved) {
    return {
      hasSaved: true,
      completed: saved.results?.length || 0,
      total: saved.videos?.length || 0
    };
  }
  return { hasSaved: false };
}

// ============================================================================
// Utility Functions
// ============================================================================

function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function sanitizeFilename(name) {
  let sanitized = (name || 'untitled').replace(/[<>:"/\\|?*]/g, '');
  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  return sanitized.length > 100 ? sanitized.substring(0, 100) : sanitized;
}

function decodeHTMLEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\n/g, ' ')
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getVideoTitle(tabId, videoId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (vid) => {
        try {
          const resp = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`);
          const data = await resp.json();
          return data.title;
        } catch {
          return document.title.replace(' - YouTube', '').trim();
        }
      },
      args: [videoId]
    });
    return results?.[0]?.result || videoId;
  } catch {
    return videoId;
  }
}

async function getPlaylistTitle(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return document.querySelector('yt-formatted-string.ytd-playlist-header-renderer')?.textContent?.trim()
          || document.querySelector('#title-text')?.textContent?.trim()
          || 'playlist';
      }
    });
    return results?.[0]?.result || 'playlist';
  } catch {
    return 'playlist';
  }
}

async function getChannelName(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return document.querySelector('#channel-name yt-formatted-string')?.textContent?.trim()
          || document.querySelector('ytd-channel-name yt-formatted-string')?.textContent?.trim()
          || 'channel';
      }
    });
    return results?.[0]?.result || 'channel';
  } catch {
    return 'channel';
  }
}

function broadcastProgress() {
  safeBroadcast({
    action: 'progressUpdate',
    progress: { ...state.progress }
  });
}

/**
 * Safely send a message to popup/other listeners.
 * Silently ignores "Receiving end does not exist" errors (popup closed).
 */
function safeBroadcast(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Check lastError to suppress "Receiving end does not exist" console errors
      if (chrome.runtime.lastError) {
        // Popup is closed, ignore
      }
    });
  } catch {
    // Extension context invalidated, ignore
  }
}
