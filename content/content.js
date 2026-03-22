/**
 * Content script injected into YouTube pages.
 * Handles page type detection and video collection from playlists/channels.
 */

let cancelFlag = false;

// ============================================================================
// Page Type Detection
// ============================================================================

function detectPageType() {
  const url = window.location.href;

  // Single video
  const videoMatch = url.match(/youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/);
  if (videoMatch) {
    const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent
      || document.title.replace(' - YouTube', '').trim();
    // Check if it's also part of a playlist
    const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    return {
      type: 'video',
      videoId: videoMatch[1],
      title: title,
      playlistId: listMatch ? listMatch[1] : null
    };
  }

  // Playlist page
  const playlistMatch = url.match(/youtube\.com\/playlist\?.*list=([a-zA-Z0-9_-]+)/);
  if (playlistMatch) {
    const title = document.querySelector('yt-formatted-string.ytd-playlist-header-renderer')?.textContent
      || document.querySelector('#title-text')?.textContent
      || 'Playlist';
    return { type: 'playlist', playlistId: playlistMatch[1], title: title.trim() };
  }

  // Channel page
  const channelMatch = url.match(/youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/);
  if (channelMatch) {
    const channelName = document.querySelector('#channel-name yt-formatted-string')?.textContent
      || document.querySelector('ytd-channel-name yt-formatted-string')?.textContent
      || channelMatch[1].replace('@', '');
    // Detect current tab
    let currentTab = 'home';
    if (url.includes('/videos')) currentTab = 'videos';
    else if (url.includes('/shorts')) currentTab = 'shorts';
    else if (url.includes('/streams')) currentTab = 'streams';
    return { type: 'channel', channelName: channelName.trim(), channelPath: channelMatch[1], currentTab };
  }

  return { type: 'unknown' };
}

// ============================================================================
// Video Collection - Playlist
// ============================================================================

async function collectPlaylistVideos(sendProgress) {
  cancelFlag = false;
  const videos = [];
  const seenIds = new Set();

  // Wait for initial content
  await waitForElement('ytd-playlist-video-renderer');

  let emptyScrollCount = 0;
  const MAX_EMPTY_SCROLLS = 5;
  const MAX_SCROLLS = 200;

  for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
    if (cancelFlag) break;

    const renderers = document.querySelectorAll('ytd-playlist-video-renderer');
    let newCount = 0;

    renderers.forEach(renderer => {
      const link = renderer.querySelector('a#video-title');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      const vidMatch = href.match(/v=([a-zA-Z0-9_-]{11})/);
      if (!vidMatch) return;
      const videoId = vidMatch[1];
      if (seenIds.has(videoId)) return;
      seenIds.add(videoId);
      newCount++;
      videos.push({
        videoId,
        title: link.textContent.trim() || 'Unknown'
      });
    });

    if (sendProgress) {
      sendProgress({ collected: videos.length, scrolling: true });
    }

    if (newCount === 0) {
      emptyScrollCount++;
      if (emptyScrollCount >= MAX_EMPTY_SCROLLS) break;
    } else {
      emptyScrollCount = 0;
    }

    // Scroll down
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1500);
  }

  return videos;
}

// ============================================================================
// Video Collection - Channel
// ============================================================================

async function collectChannelVideos(tabName, sendProgress) {
  cancelFlag = false;

  // Navigate to the correct tab if needed
  const currentUrl = window.location.href;
  const targetPath = `/${tabName}`;
  if (!currentUrl.includes(targetPath)) {
    // Find and click the tab, or navigate directly
    const baseUrl = currentUrl.replace(/\/(videos|shorts|streams|playlists|community|channels|about|featured)\/?.*$/, '');
    window.location.href = baseUrl + `/${tabName}`;
    // Wait for navigation
    await waitForNavigation();
    await sleep(2000);
  }

  const videos = [];
  const seenIds = new Set();

  // Wait for content renderers
  await waitForElement('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer');

  let emptyScrollCount = 0;
  const MAX_EMPTY_SCROLLS = 5;
  const MAX_SCROLLS = 200;

  for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
    if (cancelFlag) break;

    // Collect from various renderer types YouTube uses
    const renderers = document.querySelectorAll(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer'
    );
    let newCount = 0;

    renderers.forEach(renderer => {
      let videoId = null;
      let title = 'Unknown';

      // Try to find video link
      const link = renderer.querySelector('a#video-title-link, a#video-title, a.ytd-rich-grid-media, a#thumbnail');
      if (link) {
        const href = link.getAttribute('href') || '';
        const vidMatch = href.match(/(?:v=|\/shorts\/)([a-zA-Z0-9_-]{11})/);
        if (vidMatch) videoId = vidMatch[1];
      }

      // Try to find title
      const titleEl = renderer.querySelector('#video-title, h3 a, #video-title-link, .ytd-rich-grid-media #video-title');
      if (titleEl) title = titleEl.textContent.trim() || title;

      // For shorts/reels
      if (!videoId) {
        const reelLink = renderer.querySelector('a[href*="/shorts/"]');
        if (reelLink) {
          const href = reelLink.getAttribute('href') || '';
          const shortMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
          if (shortMatch) videoId = shortMatch[1];
          const reelTitle = renderer.querySelector('#video-title, .ytd-rich-grid-slim-media span, h3')?.textContent?.trim();
          if (reelTitle) title = reelTitle;
        }
      }

      if (!videoId || seenIds.has(videoId)) return;
      seenIds.add(videoId);
      newCount++;
      videos.push({
        videoId,
        title,
        isShort: tabName === 'shorts'
      });
    });

    if (sendProgress) {
      sendProgress({ collected: videos.length, scrolling: true });
    }

    if (newCount === 0) {
      emptyScrollCount++;
      if (emptyScrollCount >= MAX_EMPTY_SCROLLS) break;
    } else {
      emptyScrollCount = 0;
    }

    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1500);
  }

  return videos;
}

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

function waitForNavigation() {
  return new Promise(resolve => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 5000);
  });
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  if (action === 'getPageState') {
    sendResponse(detectPageType());
    return false;
  }

  if (action === 'collectPlaylistVideos') {
    collectPlaylistVideos((progress) => {
      chrome.runtime.sendMessage({ action: 'collectionProgress', ...progress });
    }).then(videos => {
      sendResponse({ success: true, videos });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }

  if (action === 'collectChannelVideos') {
    const tabName = message.tabName || 'videos';
    collectChannelVideos(tabName, (progress) => {
      chrome.runtime.sendMessage({ action: 'collectionProgress', ...progress });
    }).then(videos => {
      sendResponse({ success: true, videos });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async
  }

  if (action === 'cancelScan') {
    cancelFlag = true;
    sendResponse({ success: true });
    return false;
  }

  return false;
});
