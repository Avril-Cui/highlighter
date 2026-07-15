// ============================================================
// background.js - Service Worker
// Handles highlight storage, stats tracking, and Firestore sync
// ============================================================

importScripts('firebase-config.js', 'firebase-api.js');

// ============================================================
// Daily cleanup — keep only last 7 days of stats
// Runs once per calendar day; checked every time the service worker starts
// ============================================================

async function runDailyCleanupIfNeeded() {
  const today = getTodayString();
  const { lastCleanup } = await chrome.storage.local.get('lastCleanup');
  if (lastCleanup === today) return;

  await chrome.storage.local.set({ lastCleanup: today });

  // Build cutoff date (7 days ago)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // Clean local stats
  const { stats } = await chrome.storage.local.get('stats');
  if (stats) {
    const kept = {};
    for (const [date, data] of Object.entries(stats)) {
      if (date >= cutoffStr) kept[date] = data;
    }
    await chrome.storage.local.set({ stats: kept });
  }

  // Clean Firestore stats for the logged-in user
  const tokenData = await getValidToken();
  if (tokenData) {
    cleanupFirestoreStats(tokenData.uid, tokenData.token, cutoffStr).catch(() => {});
  }
}

// Run cleanup on service worker start
runDailyCleanupIfNeeded();

// ============================================================
// Reading stats tracking
// ============================================================

let activeTab = null; // { tabId, url, startTime }

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

async function recordTimeOnTab(tab) {
  if (!tab || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  const elapsed = Math.floor((Date.now() - tab.startTime) / 1000);
  if (elapsed < 3) return; // Skip very brief visits

  const today = getTodayString();
  await updateLocalStats(today, tab.url, elapsed);

  const tokenData = await getValidToken();
  if (tokenData) {
    syncStatsToFirestore(tokenData.uid, tokenData.token, today, tab.url, elapsed).catch(() => {});
  }
}

async function recordPageVisit(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
  const today = getTodayString();
  const { stats } = await chrome.storage.local.get('stats');
  const allStats = stats || {};
  const dayStats = allStats[today] || { pagesRead: [], readingSeconds: 0 };

  if (!dayStats.pagesRead.includes(url)) {
    dayStats.pagesRead.push(url);
    await chrome.storage.local.set({ stats: { ...allStats, [today]: dayStats } });
  }
}

async function updateLocalStats(date, url, seconds) {
  const { stats } = await chrome.storage.local.get('stats');
  const allStats = stats || {};
  const dayStats = allStats[date] || { pagesRead: [], readingSeconds: 0 };

  if (!dayStats.pagesRead.includes(url)) dayStats.pagesRead.push(url);
  dayStats.readingSeconds = (dayStats.readingSeconds || 0) + seconds;

  await chrome.storage.local.set({ stats: { ...allStats, [date]: dayStats } });
}

// Tab event listeners
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (activeTab) await recordTimeOnTab(activeTab);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      activeTab = { tabId, url: tab.url, startTime: Date.now() };
      await recordPageVisit(tab.url);
    } else {
      activeTab = null;
    }
  } catch (_) {
    activeTab = null;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || tab.url.startsWith('chrome://')) return;

  if (activeTab && activeTab.tabId === tabId && activeTab.url !== tab.url) {
    await recordTimeOnTab(activeTab);
    activeTab = { tabId, url: tab.url, startTime: Date.now() };
    await recordPageVisit(tab.url);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeTab && activeTab.tabId === tabId) {
    await recordTimeOnTab(activeTab);
    activeTab = null;
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (activeTab) {
      await recordTimeOnTab(activeTab);
      activeTab = { ...activeTab, startTime: Date.now() };
    }
  }
});

// ============================================================
// Message handler (from content.js and popup.js)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // Keep message channel open for async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_HIGHLIGHTS':
      return getHighlightsForPage(msg.url);
    case 'SAVE_HIGHLIGHT':
      return saveHighlightData(msg.highlight);
    case 'DELETE_HIGHLIGHT':
      return deleteHighlightData(msg.id, msg.url);
    case 'GET_STATS':
      return getStatsForToday();
    case 'GET_HIGHLIGHT_COUNT':
      return getLocalHighlightCount();
    case 'SYNC_ON_LOGIN':
      return syncAfterLogin(msg.uid, msg.token);
    case 'GET_SAVED_PAGES':
      return getSavedPages();
    case 'SAVE_PAGE':
      return savePage(msg.page);
    case 'DELETE_SAVED_PAGE':
      return deleteSavedPage(msg.id);
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

// ============================================================
// Highlight data operations
// ============================================================

async function getHighlightsForPage(url) {
  const { highlights } = await chrome.storage.local.get('highlights');
  const localHighlights = (highlights || {})[url] || [];

  // Try fetching from Firestore (authoritative source)
  const tokenData = await getValidToken();
  if (tokenData) {
    try {
      const remote = await fetchHighlightsFromFirestore(tokenData.uid, tokenData.token, url);
      const allHighlights = highlights || {};
      allHighlights[url] = remote;
      await chrome.storage.local.set({ highlights: allHighlights });
      return remote;
    } catch (_) {}
  }

  return localHighlights;
}

async function saveHighlightData(highlight) {
  // Write to local storage
  const { highlights } = await chrome.storage.local.get('highlights');
  const allHighlights = highlights || {};
  if (!allHighlights[highlight.url]) allHighlights[highlight.url] = [];
  // Avoid duplicates
  if (!allHighlights[highlight.url].find(h => h.id === highlight.id)) {
    allHighlights[highlight.url].push(highlight);
  }
  await chrome.storage.local.set({ highlights: allHighlights });

  // Sync to Firestore
  const tokenData = await getValidToken();
  if (tokenData) {
    saveHighlightToFirestore(tokenData.uid, tokenData.token, highlight).catch(() => {});
  }

  return { success: true };
}

async function deleteHighlightData(id, url) {
  const { highlights } = await chrome.storage.local.get('highlights');
  const allHighlights = highlights || {};
  if (allHighlights[url]) {
    allHighlights[url] = allHighlights[url].filter(h => h.id !== id);
    await chrome.storage.local.set({ highlights: allHighlights });
  }

  const tokenData = await getValidToken();
  if (tokenData) {
    deleteHighlightFromFirestore(tokenData.uid, tokenData.token, id).catch(() => {});
  }

  return { success: true };
}

async function getStatsForToday() {
  const today = getTodayString();
  const { stats } = await chrome.storage.local.get('stats');
  return (stats || {})[today] || { pagesRead: [], readingSeconds: 0 };
}

async function getLocalHighlightCount() {
  const { highlights } = await chrome.storage.local.get('highlights');
  if (!highlights) return 0;
  return Object.values(highlights).reduce((sum, arr) => sum + arr.length, 0);
}

// After login: download remote highlights to local cache
async function syncAfterLogin(uid, token) {
  try {
    // Fetch all highlights for the user (query without URL filter)
    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/highlights?pageSize=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const docs = data.documents || [];

    const { highlights } = await chrome.storage.local.get('highlights');
    const allHighlights = highlights || {};

    for (const doc of docs) {
      const h = firestoreDocToHighlight(doc);
      if (!allHighlights[h.url]) allHighlights[h.url] = [];
      if (!allHighlights[h.url].find(x => x.id === h.id)) {
        allHighlights[h.url].push(h);
      }
    }

    await chrome.storage.local.set({ highlights: allHighlights });

    // Also sync saved pages
    const savedRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/users/${uid}/savedPages?pageSize=500`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (savedRes.ok) {
      const savedData = await savedRes.json();
      const remoteSaved = (savedData.documents || []).map(d => firestoreDocToSavedPage(d));
      const { savedPages } = await chrome.storage.local.get('savedPages');
      const local = savedPages || [];
      for (const p of remoteSaved) {
        if (!local.find(x => x.id === p.id)) local.push(p);
      }
      await chrome.storage.local.set({ savedPages: local });
    }
  } catch (_) {}
}

// ============================================================
// Saved pages data operations
// ============================================================

async function getSavedPages() {
  const { savedPages } = await chrome.storage.local.get('savedPages');
  const local = savedPages || [];

  // Refresh from Firestore in background (non-blocking)
  const tokenData = await getValidToken();
  if (tokenData) {
    getSavedPagesFromFirestore(tokenData.uid, tokenData.token)
      .then(async remote => {
        // Merge: remote wins for any matching id
        const merged = [...local];
        for (const r of remote) {
          if (!merged.find(x => x.id === r.id)) merged.push(r);
        }
        await chrome.storage.local.set({ savedPages: merged });
      })
      .catch(() => {});
  }

  return local;
}

async function savePage(page) {
  // Persist locally
  const { savedPages } = await chrome.storage.local.get('savedPages');
  const all = savedPages || [];
  all.unshift(page); // newest first
  await chrome.storage.local.set({ savedPages: all });

  // Sync to Firestore
  const tokenData = await getValidToken();
  if (tokenData) {
    savePageToFirestore(tokenData.uid, tokenData.token, page).catch(() => {});
  }

  return { success: true };
}

async function deleteSavedPage(id) {
  const { savedPages } = await chrome.storage.local.get('savedPages');
  const filtered = (savedPages || []).filter(p => p.id !== id);
  await chrome.storage.local.set({ savedPages: filtered });

  const tokenData = await getValidToken();
  if (tokenData) {
    deleteSavedPageFromFirestore(tokenData.uid, tokenData.token, id).catch(() => {});
  }

  return { success: true };
}
