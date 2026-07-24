// ============================================================
// Firebase REST API helpers
// Used by both background.js (via importScripts) and popup.js (via <script>)
// ============================================================

const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_BASE = 'https://securetoken.googleapis.com/v1';

function firestoreBase() {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;
}

// ============================================================
// Token management
// ============================================================

async function getValidToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['user'], async (result) => {
      const user = result.user;
      if (!user || !user.idToken) { resolve(null); return; }

      // Refresh if expires within 60 seconds
      if (Date.now() >= user.expiresAt - 60000) {
        try {
          const refreshed = await refreshIdToken(user.refreshToken);
          const updatedUser = { ...user, ...refreshed };
          chrome.storage.local.set({ user: updatedUser });
          resolve({ token: refreshed.idToken, uid: user.uid });
        } catch (e) {
          chrome.storage.local.remove('user');
          resolve(null);
        }
      } else {
        resolve({ token: user.idToken, uid: user.uid });
      }
    });
  });
}

async function refreshIdToken(refreshToken) {
  const res = await fetch(`${TOKEN_BASE}/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + parseInt(data.expires_in) * 1000
  };
}

function buildUserRecord(data) {
  return {
    uid: data.localId,
    email: data.email,
    displayName: data.displayName || data.email?.split('@')[0] || 'User',
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + parseInt(data.expiresIn) * 1000
  };
}

// ============================================================
// Authentication
// ============================================================

async function signUpWithEmail(email, password) {
  const res = await fetch(`${AUTH_BASE}/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json();
  if (data.error) throw new Error(friendlyAuthError(data.error.message));
  const user = buildUserRecord(data);
  await chrome.storage.local.set({ user });
  return user;
}

async function signInWithEmail(email, password) {
  const res = await fetch(`${AUTH_BASE}/accounts:signInWithPassword?key=${FIREBASE_CONFIG.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json();
  if (data.error) throw new Error(friendlyAuthError(data.error.message));
  const user = buildUserRecord(data);
  await chrome.storage.local.set({ user });
  return user;
}

async function signInWithGoogle() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in cancelled'));
        return;
      }
      try {
        const res = await fetch(`${AUTH_BASE}/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            postBody: `access_token=${token}&providerId=google.com`,
            requestUri: 'http://localhost',
            returnIdpCredential: true,
            returnSecureToken: true
          })
        });
        const data = await res.json();
        if (data.error) throw new Error(friendlyAuthError(data.error.message));
        const user = buildUserRecord(data);
        await chrome.storage.local.set({ user });
        resolve(user);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function signOut() {
  // Revoke Google token if present
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) chrome.identity.removeCachedAuthToken({ token });
      chrome.storage.local.remove('user', resolve);
    });
  });
}

async function getCurrentUser() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['user'], (result) => {
      resolve(result.user || null);
    });
  });
}

function friendlyAuthError(code) {
  const map = {
    'EMAIL_EXISTS': 'An account with this email already exists.',
    'INVALID_EMAIL': 'Please enter a valid email address.',
    'WEAK_PASSWORD : Password should be at least 6 characters': 'Password must be at least 6 characters.',
    'INVALID_LOGIN_CREDENTIALS': 'Incorrect email or password.',
    'USER_DISABLED': 'This account has been disabled.',
    'TOO_MANY_ATTEMPTS_TRY_LATER': 'Too many attempts. Please try again later.',
  };
  return map[code] || code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
}

// ============================================================
// Settings (Firestore)
// ============================================================

const DEFAULT_SETTINGS = {
  highlightColor: '#FFFF00',
  textColor: '#000000',
  confirmKey: 'Space'
};

async function getSettings() {
  // Always read from local storage first (fast, no auth needed)
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], async (result) => {
      const local = result.settings || { ...DEFAULT_SETTINGS };
      resolve(local);

      // Sync from Firestore in background
      const tokenData = await getValidToken();
      if (!tokenData) return;
      try {
        const res = await fetch(
          `${firestoreBase()}/users/${tokenData.uid}/settings`,
          { headers: { Authorization: `Bearer ${tokenData.token}` } }
        );
        if (res.ok) {
          const doc = await res.json();
          const remote = firestoreToSettings(doc);
          chrome.storage.local.set({ settings: remote });
        }
      } catch (_) {}
    });
  });
}

async function saveSettings(settings) {
  // Save locally immediately
  await chrome.storage.local.set({ settings });

  // Sync to Firestore if logged in
  const tokenData = await getValidToken();
  if (!tokenData) return;

  await fetch(
    `${firestoreBase()}/users/${tokenData.uid}/settings?updateMask.fieldPaths=highlightColor&updateMask.fieldPaths=textColor&updateMask.fieldPaths=confirmKey`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenData.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          highlightColor: { stringValue: settings.highlightColor },
          textColor: { stringValue: settings.textColor },
          confirmKey: { stringValue: settings.confirmKey }
        }
      })
    }
  );
}

function firestoreToSettings(doc) {
  if (!doc || !doc.fields) return { ...DEFAULT_SETTINGS };
  const f = doc.fields;
  return {
    highlightColor: f.highlightColor?.stringValue || DEFAULT_SETTINGS.highlightColor,
    textColor: f.textColor?.stringValue || DEFAULT_SETTINGS.textColor,
    confirmKey: f.confirmKey?.stringValue || DEFAULT_SETTINGS.confirmKey
  };
}

// ============================================================
// Highlights (Firestore)
// ============================================================

async function fetchHighlightsFromFirestore(uid, token, url) {
  const res = await fetch(
    `${firestoreBase()}/users/${uid}:runQuery`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'highlights' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'url' },
              op: 'EQUAL',
              value: { stringValue: url }
            }
          }
        }
      })
    }
  );
  if (!res.ok) throw new Error(`Firestore query failed: ${res.status}`);
  const results = await res.json();
  return results
    .filter(r => r.document)
    .map(r => firestoreDocToHighlight(r.document));
}

async function saveHighlightToFirestore(uid, token, highlight) {
  // Check if document with this ID already exists (avoid duplicates on re-sync)
  const res = await fetch(
    `${firestoreBase()}/users/${uid}/highlights?documentId=${highlight.id}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(highlightToFirestoreDoc(highlight))
    }
  );
  if (!res.ok && res.status !== 409) {
    const err = await res.json();
    throw new Error(err.error?.message || 'Failed to save highlight');
  }
}

async function deleteHighlightFromFirestore(uid, token, highlightId) {
  await fetch(
    `${firestoreBase()}/users/${uid}/highlights/${highlightId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }
  );
}

async function getTotalHighlightCount(uid, token) {
  const res = await fetch(
    `${firestoreBase()}/users/${uid}/highlights?pageSize=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return 0;
  const data = await res.json();
  // Firestore doesn't directly return counts; approximate with local storage
  return data.documents?.length || 0;
}

function firestoreDocToHighlight(doc) {
  const f = doc.fields;
  const id = doc.name.split('/').pop();
  const comments = (f.comments?.arrayValue?.values || []).map(v => {
    const cf = v.mapValue?.fields || {};
    return {
      id:        cf.id?.stringValue        || '',
      text:      cf.text?.stringValue      || '',
      createdAt: cf.createdAt?.timestampValue || new Date().toISOString()
    };
  }).filter(c => c.id && c.text);
  return {
    id,
    url:         f.url?.stringValue         || '',
    text:        f.text?.stringValue        || '',
    startXPath:  f.startXPath?.stringValue  || '',
    startOffset: parseInt(f.startOffset?.integerValue || '0'),
    endXPath:    f.endXPath?.stringValue    || '',
    endOffset:   parseInt(f.endOffset?.integerValue   || '0'),
    color:       f.color?.stringValue       || '#FFFF00',
    textColor:   f.textColor?.stringValue   || '#000000',
    createdAt:   f.createdAt?.timestampValue || new Date().toISOString(),
    comments
  };
}

function commentsToFirestoreArray(comments) {
  if (!comments || comments.length === 0) {
    return { arrayValue: {} }; // empty array — omit values key to avoid REST API issues
  }
  return {
    arrayValue: {
      values: comments.map(c => ({
        mapValue: {
          fields: {
            id:        { stringValue: c.id },
            text:      { stringValue: c.text },
            createdAt: { timestampValue: c.createdAt }
          }
        }
      }))
    }
  };
}

function highlightToFirestoreDoc(h) {
  const fields = {
    url:         { stringValue: h.url },
    text:        { stringValue: h.text },
    startXPath:  { stringValue: h.startXPath },
    startOffset: { integerValue: String(h.startOffset) },
    endXPath:    { stringValue: h.endXPath },
    endOffset:   { integerValue: String(h.endOffset) },
    color:       { stringValue: h.color },
    textColor:   { stringValue: h.textColor },
    createdAt:   { timestampValue: h.createdAt || new Date().toISOString() }
  };
  // Only include comments field when there are comments.
  // Sending { arrayValue: {} } for an empty array causes Firestore REST API
  // to return a 400 error, which silently blocks the entire highlight save.
  if (h.comments && h.comments.length > 0) {
    fields.comments = commentsToFirestoreArray(h.comments);
  }
  return { fields };
}

async function updateHighlightCommentsInFirestore(uid, token, highlightId, comments) {
  await fetch(
    `${firestoreBase()}/users/${uid}/highlights/${highlightId}?updateMask.fieldPaths=comments`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { comments: commentsToFirestoreArray(comments) } })
    }
  );
}

// ============================================================
// Stats (Firestore)
// ============================================================

async function cleanupFirestoreStats(uid, token, cutoffDateStr) {
  // List all documents in users/{uid}/stats
  const res = await fetch(
    `${firestoreBase()}/users/${uid}/stats`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return;
  const data = await res.json();

  const deletions = (data.documents || [])
    .filter(doc => {
      const dateId = doc.name.split('/').pop();
      return dateId < cutoffDateStr; // older than cutoff
    })
    .map(doc =>
      fetch(`https://firestore.googleapis.com/v1/${doc.name.split('/v1/')[1]}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {})
    );

  await Promise.all(deletions);
}

// ============================================================
// Saved Pages (Firestore)
// ============================================================

async function getSavedPagesFromFirestore(uid, token) {
  const res = await fetch(
    `${firestoreBase()}/users/${uid}:runQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'savedPages' }],
          orderBy: [{ field: { fieldPath: 'savedAt' }, direction: 'DESCENDING' }]
        }
      })
    }
  );
  if (!res.ok) return [];
  const results = await res.json();
  return results.filter(r => r.document).map(r => firestoreDocToSavedPage(r.document));
}

async function savePageToFirestore(uid, token, page) {
  await fetch(
    `${firestoreBase()}/users/${uid}/savedPages?documentId=${page.id}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          url:     { stringValue: page.url },
          title:   { stringValue: page.title },
          note:    { stringValue: page.note || '' },
          savedAt: { timestampValue: page.savedAt }
        }
      })
    }
  );
}

async function deleteSavedPageFromFirestore(uid, token, pageId) {
  await fetch(
    `${firestoreBase()}/users/${uid}/savedPages/${pageId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
}

function firestoreDocToSavedPage(doc) {
  const f  = doc.fields;
  const id = doc.name.split('/').pop();
  return {
    id,
    url:     f.url?.stringValue     || '',
    title:   f.title?.stringValue   || '',
    note:    f.note?.stringValue    || '',
    savedAt: f.savedAt?.timestampValue || new Date().toISOString()
  };
}

async function syncStatsToFirestore(uid, token, date, url, additionalSeconds) {
  const docPath = `${firestoreBase()}/users/${uid}/stats/${date}`;

  // Fetch current remote stats
  let remote = { pagesRead: [], readingSeconds: 0 };
  try {
    const res = await fetch(docPath, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const doc = await res.json();
      if (doc.fields) {
        remote.pagesRead = (doc.fields.pagesRead?.arrayValue?.values || []).map(v => v.stringValue);
        remote.readingSeconds = parseInt(doc.fields.readingSeconds?.integerValue || '0');
      }
    }
  } catch (_) {}

  if (!remote.pagesRead.includes(url)) remote.pagesRead.push(url);
  remote.readingSeconds += additionalSeconds;

  await fetch(
    `${docPath}?updateMask.fieldPaths=pagesRead&updateMask.fieldPaths=readingSeconds`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          pagesRead: {
            arrayValue: { values: remote.pagesRead.map(u => ({ stringValue: u })) }
          },
          readingSeconds: { integerValue: String(remote.readingSeconds) }
        }
      })
    }
  );
}
