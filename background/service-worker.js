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
      // If currently in collection phase, tell the content script to stop scrolling
      if (state.phase === 'collecting' && state.tabId) {
        safeSendToTab(state.tabId, { action: 'cancelScan' });
      }
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

  // Clear any leftover saved state from a previous run to free quota before writing new progress.
  await clearSavedState();

  try {
    // Step 1: Collect videos
    const videos = await collectVideos(config);
    if (!videos || videos.length === 0) {
      throw new Error('No videos found');
    }

    // Check if cancelled during collection
    if (state.isCancelled) {
      state.phase = 'idle';
      safeBroadcast({ action: 'extractionError', error: 'Extraction cancelled' });
      return { success: true };
    }

    state.videos = videos;
    state.progress.total = videos.length;
    state.progress.remaining = videos.length;
    state.phase = 'fetching';

    broadcastProgress();

    // Step 2: Extract transcripts
    await runBatchExtraction(videos, config.tabId, state.concurrency);

    // Check if cancelled during extraction
    if (state.isCancelled) {
      await saveProgress();
      state.phase = 'idle';
      safeBroadcast({ action: 'extractionError', error: 'Extraction cancelled' });
      return { success: true };
    }

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
    // Navigate the tab to the playlist URL if needed.
    // This handles the case where the user picked a playlist from the channel's
    // playlists tab — the tab is still on the channel page, not the playlist.
    await navigateTabToUrl(tabId, url);
    await ensureContentScriptInjected(tabId);
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
 * Navigate a tab to a URL only if it is not already on that page.
 * Used to send the tab to the correct playlist before collecting videos.
 */
async function navigateTabToUrl(tabId, url) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const currentUrl = tab.url || '';
    // Extract the playlist ID from both URLs; skip navigation if already on the same playlist
    const targetListId = url.match(/[?&]list=([a-zA-Z0-9_-]+)/)?.[1];
    if (targetListId && currentUrl.includes(targetListId)) return; // Already on correct page
    // Navigate the tab
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId);
    await sleep(1500); // Extra wait for YouTube SPA to render initial content
  } catch {
    // Tab may be gone or navigation unsupported — proceed anyway
  }
}

/**
 * Wait for a tab to finish loading (status === 'complete'), with a 10s timeout.
 */
function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });
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
  // Build a set of already-processed video IDs to prevent duplicates.
  // Covers: resume runs, channel "Both" mode collecting the same video from Videos + Shorts tabs.
  const processedIds = new Set(state.results.map(r => r.videoId));

  while (queue.length > 0 && !state.isCancelled) {
    // Handle pause
    while (state.isPaused && !state.isCancelled) {
      await sleep(500);
    }
    if (state.isCancelled) break;

    const video = queue.shift();
    if (!video) break;

    // Deduplication filter — skip videos already in results
    if (processedIds.has(video.videoId)) {
      state.progress.remaining = queue.length;
      broadcastProgress();
      continue;
    }

    state.progress.currentVideo = video.title;
    safeBroadcast({ action: 'currentVideo', title: video.title });

    try {
      // Try direct service-worker extraction first (bypasses page-level poToken restrictions)
      let result = await extractTranscriptDirect(video.videoId);

      // Fall back to MAIN world extraction if direct method failed
      if (!result || !result.segments || result.segments.length === 0) {
        result = await extractTranscriptInMainWorld(tabId, video.videoId);
      }

      if (result && result.segments && result.segments.length > 0) {
        const fullText = result.segments.map(s => decodeHTMLEntities(s.text)).join(' ').trim();
        // Empty-transcript filter — segments exist but all text is blank/whitespace
        if (fullText.length > 0) {
          state.results.push({
            videoId: video.videoId,
            title: video.title,
            transcript: fullText,
            segments: result.segments,
            language: result.language || 'Unknown',
            status: 'success'
          });
          state.progress.success++;
        } else {
          state.results.push({
            videoId: video.videoId,
            title: video.title,
            transcript: null,
            segments: null,
            language: null,
            status: 'no_transcript'
          });
          state.progress.noTranscript++;
        }
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

    // Mark as processed so concurrent workers skip this ID
    processedIds.add(video.videoId);

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
// Transcript Extraction (Direct — service worker context)
// ============================================================================
// Fetches transcripts directly from the service worker, bypassing YouTube's
// page-level poToken/bot-detection that blocks MAIN world API calls.

async function extractTranscriptDirect(videoId) {
  // ================================================================
  // Method 1: get_transcript endpoint (primary — does NOT require poToken)
  // This is YouTube's dedicated transcript API, separate from the player API.
  // ================================================================
  try {
    const params = encodeGetTranscriptParams(videoId);
    const resp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20250312.04.00',
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250312.04.00',
            hl: 'en',
            gl: 'US',
          }
        },
        params
      })
    });
    const data = await resp.json();
    const segments = parseGetTranscriptResponse(data);
    if (segments.length > 0) {
      return { segments, language: 'English (transcript)' };
    }
  } catch {
    // get_transcript failed — try fallback methods
  }

  // ================================================================
  // Method 2: Scrape embed page HTML for caption tracks
  // Embed pages return full HTML (not SPA JSON) and don't need poToken.
  // ================================================================
  let captionTracks = null;
  try {
    const pageResp = await fetch(`https://www.youtube.com/embed/${videoId}`, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const html = await pageResp.text();

    const patterns = [
      /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s,
      /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      try {
        const jsonStr = match[1];
        let depth = 0, endIdx = 0;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') depth++;
          else if (jsonStr[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
        }
        if (endIdx > 0) {
          const playerData = JSON.parse(jsonStr.substring(0, endIdx));
          captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (captionTracks && captionTracks.length > 0) break;
        }
      } catch { continue; }
    }
  } catch {
    // Embed page fetch failed
  }

  // ================================================================
  // Method 3: Innertube player API (legacy fallback — may require poToken)
  // ================================================================
  if (!captionTracks || captionTracks.length === 0) {
    const clients = [
      { clientName: 'WEB', clientVersion: '2.20250312.04.00', clientId: '1' },
      { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.0', clientId: '56',
        thirdParty: { embedUrl: 'https://www.youtube.com/' } },
    ];

    for (const client of clients) {
      if (captionTracks && captionTracks.length > 0) break;
      try {
        const body = {
          videoId,
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: 'en',
              gl: 'US',
            }
          }
        };
        if (client.thirdParty) body.context.thirdParty = client.thirdParty;

        const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Youtube-Client-Name': client.clientId,
            'X-Youtube-Client-Version': client.clientVersion,
          },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      } catch {
        // Try next client
      }
    }
  }

  if (!captionTracks || captionTracks.length === 0) {
    return { noTranscript: true };
  }

  // Select best caption track (priority: manual English > auto English > translated > any)
  let selected = null;
  let tr = captionTracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr');
  if (tr) { selected = { track: tr, method: 'english' }; }
  if (!selected) {
    tr = captionTracks.find(t => t.languageCode?.startsWith('en'));
    if (tr) { selected = { track: tr, method: 'english-auto' }; }
  }
  if (!selected) {
    tr = captionTracks.find(t => t.isTranslatable !== false);
    if (tr) { selected = { track: tr, method: 'translated', tlang: 'en' }; }
  }
  if (!selected && captionTracks.length > 0) {
    selected = { track: captionTracks[0], method: 'original' };
  }
  if (!selected) return { noTranscript: true };

  const { track, method, tlang } = selected;
  let baseUrl = track.baseUrl;
  if (tlang) baseUrl += (baseUrl.includes('?') ? '&' : '?') + 'tlang=' + tlang;

  // Fetch transcript — json3 format (works in service worker without DOMParser)
  let segments = [];
  try {
    const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
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
              text,
            });
          }
        }
      }
    }
  } catch {
    // json3 failed
  }

  // Fallback: plain XML format (regex-based, no DOMParser in service worker)
  if (segments.length === 0) {
    try {
      const resp = await fetch(baseUrl);
      const xml = await resp.text();
      const textRegex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
      let m;
      while ((m = textRegex.exec(xml)) !== null) {
        const rawText = m[3].replace(/<[^>]+>/g, '').trim();
        if (rawText) {
          segments.push({
            start: parseFloat(m[1]) || 0,
            duration: parseFloat(m[2]) || 0,
            text: rawText,
          });
        }
      }
    } catch {
      // XML also failed
    }
  }

  if (segments.length === 0) return { noTranscript: true };

  // Build language info
  let language = track.name?.simpleText || track.languageCode || 'Unknown';
  if (method === 'english') language = 'English (' + (track.kind === 'asr' ? 'auto-generated' : 'manual') + ')';
  else if (method === 'english-auto') language = 'English (auto-generated)';
  else if (method === 'translated') language = 'Translated from ' + (track.name?.simpleText || track.languageCode);
  else if (method === 'original') language = (track.name?.simpleText || track.languageCode) + ' (no English available)';

  return { segments, language };
}

// ============================================================================
// Transcript Extraction (Main World — fallback)
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
 * It has access to same-origin fetch, cookies, and YouTube's JS globals.
 */
async function mainWorldExtractTranscript(videoId) {
  try {
    // ---- Helper: encode protobuf params for get_transcript ----
    function encodeParams(vid) {
      const bytes = [0x0A, vid.length];
      for (let i = 0; i < vid.length; i++) bytes.push(vid.charCodeAt(i));
      return btoa(String.fromCharCode(...bytes));
    }

    // ---- Helper: parse get_transcript response ----
    function parseResponse(data) {
      const segs = [];
      try {
        const actions = data?.actions;
        if (!actions) return segs;
        for (const action of actions) {
          const body = action?.updateEngagementPanelAction?.content
            ?.transcriptRenderer?.content
            ?.transcriptSearchPanelRenderer?.body
            ?.transcriptSegmentListRenderer?.initialSegments;
          if (!body) continue;
          for (const item of body) {
            const r = item?.transcriptSegmentRenderer;
            if (!r) continue;
            const text = r.snippet?.runs?.map(x => x.text || '').join('').trim();
            if (text) {
              segs.push({
                start: (parseInt(r.startMs) || 0) / 1000,
                duration: ((parseInt(r.endMs) || 0) - (parseInt(r.startMs) || 0)) / 1000,
                text
              });
            }
          }
        }
      } catch {}
      return segs;
    }

    // ---- Helper: balanced-brace JSON extraction ----
    function extractJSON(str) {
      let depth = 0, end = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        try { return JSON.parse(str.substring(0, end)); } catch {}
      }
      return null;
    }

    let captionTracks = null;

    // ================================================================
    // Method 1: get_transcript endpoint (primary — does NOT need poToken)
    // Uses YouTube's dedicated transcript API with page cookies/auth.
    // ================================================================
    try {
      const params = encodeParams(videoId);
      const ytcfg = window.ytcfg;
      const apiKey = ytcfg?.get?.('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
      const clientVersion = ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20250312.04.00';

      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': clientVersion,
          },
          credentials: 'include',
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: clientVersion,
                hl: 'en',
                gl: 'US',
              }
            },
            params
          })
        }
      );

      const data = await resp.json();
      const segments = parseResponse(data);
      if (segments.length > 0) {
        return { segments, language: 'English (transcript)' };
      }
    } catch {
      // get_transcript failed
    }

    // ================================================================
    // Method 2: Fetch embed page for caption tracks
    // Embed pages always return full HTML (not SPA JSON).
    // ================================================================
    try {
      const resp = await fetch(`https://www.youtube.com/embed/${videoId}`, {
        credentials: 'include',
        headers: { 'Accept': 'text/html,application/xhtml+xml' }
      });
      const html = await resp.text();

      for (const pat of [
        /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s,
        /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s,
      ]) {
        const m = html.match(pat);
        if (!m) continue;
        const obj = extractJSON(m[1]);
        if (obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length > 0) {
          captionTracks = obj.captions.playerCaptionsTracklistRenderer.captionTracks;
          break;
        }
      }
    } catch {
      // Embed page failed
    }

    // ================================================================
    // Method 3: ytInitialPlayerResponse on the current page
    // ================================================================
    if (!captionTracks?.length) {
      try {
        captionTracks = window.ytInitialPlayerResponse?.captions
          ?.playerCaptionsTracklistRenderer?.captionTracks;
      } catch {}
    }

    // ================================================================
    // Method 4: Innertube player API with page credentials
    // ================================================================
    if (!captionTracks?.length) {
      try {
        const ytcfg = window.ytcfg;
        const apiKey = ytcfg?.get?.('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        const clientVersion = ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20250312.04.00';
        const visitorData = ytcfg?.get?.('VISITOR_DATA') || '';

        const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Youtube-Client-Name': '1',
            'X-Youtube-Client-Version': clientVersion,
          },
          credentials: 'include',
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: clientVersion,
                hl: 'en',
                gl: 'US',
                visitorData,
              }
            },
            playbackContext: {
              contentPlaybackContext: {
                signatureTimestamp: ytcfg?.get?.('STS') || undefined
              }
            }
          })
        });

        const data = await resp.json();
        captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      } catch {}
    }

    // ================================================================
    // No caption tracks found by any method
    // ================================================================
    if (!captionTracks?.length) {
      return { noTranscript: true };
    }

    // Select best caption track (priority: manual EN > auto EN > translatable > any)
    let selected = null;
    let tr = captionTracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr');
    if (tr) selected = { track: tr, method: 'english' };
    if (!selected) {
      tr = captionTracks.find(t => t.languageCode?.startsWith('en'));
      if (tr) selected = { track: tr, method: 'english-auto' };
    }
    if (!selected) {
      tr = captionTracks.find(t => t.isTranslatable !== false);
      if (tr) selected = { track: tr, method: 'translated', tlang: 'en' };
    }
    if (!selected && captionTracks.length > 0) {
      selected = { track: captionTracks[0], method: 'original' };
    }
    if (!selected) return { noTranscript: true };

    const { track, method, tlang } = selected;
    let baseUrl = track.baseUrl;
    if (tlang) baseUrl += (baseUrl.includes('?') ? '&' : '?') + 'tlang=' + tlang;

    // Fetch transcript — json3 first, then XML
    let segments = [];

    try {
      const json3Url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
      const resp = await fetch(json3Url, { credentials: 'include' });
      const data = await resp.json();
      if (data.events) {
        for (const event of data.events) {
          if (event.segs) {
            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (text && text !== '\n') {
              segments.push({
                start: (event.tStartMs || 0) / 1000,
                duration: (event.dDurationMs || 0) / 1000,
                text
              });
            }
          }
        }
      }
    } catch {}

    if (segments.length === 0) {
      try {
        const resp = await fetch(baseUrl, { credentials: 'include' });
        const xml = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'text/xml');
        const textNodes = doc.querySelectorAll('text, p');
        textNodes.forEach(node => {
          const text = node.textContent.trim();
          if (text) {
            const startAttr = node.getAttribute('start') || node.getAttribute('t');
            const durAttr = node.getAttribute('dur') || node.getAttribute('d');
            const isMs = node.hasAttribute('t') || node.hasAttribute('d');
            segments.push({
              start: parseFloat(startAttr || 0) / (isMs ? 1000 : 1),
              duration: parseFloat(durAttr || 0) / (isMs ? 1000 : 1),
              text
            });
          }
        });
      } catch {}
    }

    if (segments.length === 0) return { noTranscript: true };

    let language = track.name?.simpleText || track.languageCode || 'Unknown';
    if (method === 'english') language = 'English (' + (track.kind === 'asr' ? 'auto-generated' : 'manual') + ')';
    else if (method === 'english-auto') language = 'English (auto-generated)';
    else if (method === 'translated') language = 'Translated from ' + (track.name?.simpleText || track.languageCode);
    else if (method === 'original') language = (track.name?.simpleText || track.languageCode) + ' (no English available)';

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
  const filename = sanitizeFilename(sourceName) + '.md';
  await downloadTextFile(content, filename, 'text/markdown');
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
    await downloadTextFile(files[0].content, files[0].name, 'text/markdown');
  } else {
    await downloadAsZip(files, `${sanitizeFilename(sourceName)}_transcripts.zip`);
  }
}

async function generateSRTOutput(results, sourceName) {
  const successResults = results.filter(r => r.status === 'success' && r.segments);

  if (successResults.length === 1) {
    const content = formatSRT(successResults[0].segments);
    const filename = sanitizeFilename(successResults[0].title || sourceName) + '.srt';
    await downloadTextFile(content, filename, 'application/x-subrip');
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
  // Minimal ZIP implementation for service worker context (no URL.createObjectURL)
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

  // Convert to data URL (service workers don't have URL.createObjectURL)
  await downloadBinaryFile(zipData, zipFilename, 'application/zip');
}

// ============================================================================
// Download Helpers (service workers don't have URL.createObjectURL)
// ============================================================================

/**
 * Download a text file using data URL.
 */
async function downloadTextFile(content, filename, mimeType) {
  // Encode content as base64 data URL
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const base64 = uint8ToBase64(bytes);
  const dataUrl = `data:${mimeType || 'text/plain'};base64,${base64}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: true
  });
}

/**
 * Download binary data using data URL.
 */
async function downloadBinaryFile(uint8Array, filename, mimeType) {
  const base64 = uint8ToBase64(uint8Array);
  const dataUrl = `data:${mimeType || 'application/octet-stream'};base64,${base64}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: true
  });
}

/**
 * Convert Uint8Array to base64 string (works in service worker).
 */
function uint8ToBase64(uint8Array) {
  // Process in chunks to avoid call stack overflow on large files
  const CHUNK_SIZE = 32768;
  let result = '';
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length));
    result += String.fromCharCode.apply(null, chunk);
  }
  return btoa(result);
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
  // Omit transcript — it's redundant with segments and saves significant quota space.
  // It will be reconstructed from segments when loaded via loadSavedProgress().
  const saveResults = state.results.map(r => ({
    videoId: r.videoId,
    title: r.title,
    segments: r.segments,
    language: r.language,
    status: r.status,
    error: r.error
  }));

  try {
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
  } catch (err) {
    // QuotaBytes exceeded or other storage error — warn but do not abort the extraction.
    // All data is still in memory and the run can complete normally.
    console.warn('[saveProgress] Storage write failed:', err.message);
  }
}

async function loadSavedProgress() {
  const { savedState } = await chrome.storage.local.get('savedState');
  if (!savedState || (Date.now() - savedState.timestamp) >= 86400000) {
    return null;
  }

  // Reconstruct transcript from segments for any result that lacks it.
  // New saves omit transcript to save quota; old saves that already have it pass through unchanged.
  if (Array.isArray(savedState.results)) {
    savedState.results = savedState.results.map(r => {
      if (r.status === 'success' && r.segments && !r.transcript) {
        return { ...r, transcript: r.segments.map(s => decodeHTMLEntities(s.text)).join(' ') };
      }
      return r;
    });
  }

  return savedState;
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

async function clearSavedState() {
  try {
    await chrome.storage.local.remove('savedState');
  } catch (err) {
    console.warn('[clearSavedState] Failed to remove saved state:', err.message);
  }
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

/**
 * Encode a video ID into protobuf params for the get_transcript endpoint.
 * Format: field 1 (LEN) containing the video ID string.
 */
function encodeGetTranscriptParams(videoId) {
  const bytes = [0x0A, videoId.length];
  for (let i = 0; i < videoId.length; i++) bytes.push(videoId.charCodeAt(i));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Parse the response from YouTube's get_transcript endpoint.
 * Returns an array of { start, duration, text } segments.
 */
function parseGetTranscriptResponse(data) {
  const segments = [];
  try {
    const actions = data?.actions;
    if (!actions) return segments;
    for (const action of actions) {
      const body = action?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.content
        ?.transcriptSearchPanelRenderer?.body
        ?.transcriptSegmentListRenderer?.initialSegments;
      if (!body) continue;
      for (const item of body) {
        const seg = item?.transcriptSegmentRenderer;
        if (!seg) continue;
        const text = seg.snippet?.runs?.map(r => r.text || '').join('').trim();
        if (text) {
          const startMs = parseInt(seg.startMs) || 0;
          const endMs = parseInt(seg.endMs) || 0;
          segments.push({
            start: startMs / 1000,
            duration: (endMs - startMs) / 1000,
            text
          });
        }
      }
    }
  } catch {
    // Parse error
  }
  return segments;
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
