// ============================================================
// popup.js — Popup logic (auth, settings, stats)
// ============================================================

'use strict';

// Boot is at the BOTTOM of this file (after all functions are defined)

// ============================================================
// Screen toggling
// ============================================================

function showAuthScreen() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

async function showMainScreen(user) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');

  document.getElementById('header-email').textContent = user.email || user.displayName || '';

  await loadAndApplySettings();
}

// ============================================================
// Auth tabs (Sign In / Sign Up)
// ============================================================

function setupAuthTabs() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.remove('hidden');
      clearAuthErrors();
    });
  });
}

function clearAuthErrors() {
  ['signin-error', 'signup-error'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = '';
    el.classList.add('hidden');
  });
}

function showError(elementId, msg) {
  const el = document.getElementById(elementId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// Auth buttons
// ============================================================

function setupAuthButtons() {
  // Sign In
  document.getElementById('signin-btn').addEventListener('click', async () => {
    const email    = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;
    if (!email || !password) { showError('signin-error', 'Please fill in all fields.'); return; }
    setLoading('signin-btn', true);
    try {
      const user = await signInWithEmail(email, password);
      afterLogin(user);
    } catch (e) {
      showError('signin-error', e.message);
    } finally {
      setLoading('signin-btn', false);
    }
  });

  // Sign Up
  document.getElementById('signup-btn').addEventListener('click', async () => {
    const email    = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm  = document.getElementById('signup-confirm').value;
    if (!email || !password || !confirm) { showError('signup-error', 'Please fill in all fields.'); return; }
    if (password !== confirm)            { showError('signup-error', 'Passwords do not match.'); return; }
    if (password.length < 6)            { showError('signup-error', 'Password must be at least 6 characters.'); return; }
    setLoading('signup-btn', true);
    try {
      const user = await signUpWithEmail(email, password);
      afterLogin(user);
    } catch (e) {
      showError('signup-error', e.message);
    } finally {
      setLoading('signup-btn', false);
    }
  });

  // Google Sign In / Sign Up (same flow)
  ['google-signin-btn', 'google-signup-btn'].forEach(id => {
    document.getElementById(id).addEventListener('click', async () => {
      setLoading(id, true);
      try {
        const user = await signInWithGoogle();
        afterLogin(user);
      } catch (e) {
        const errId = id.includes('signin') ? 'signin-error' : 'signup-error';
        showError(errId, e.message);
      } finally {
        setLoading(id, false);
      }
    });
  });
}

async function afterLogin(user) {
  // Trigger background sync of remote highlights to local cache
  chrome.runtime.sendMessage({ type: 'SYNC_ON_LOGIN', uid: user.uid, token: user.idToken });
  showMainScreen(user);
}

function setLoading(buttonId, loading) {
  const btn = document.getElementById(buttonId);
  btn.disabled = loading;
  btn.style.opacity = loading ? '0.7' : '1';
}

// ============================================================
// Logout
// ============================================================

function setupLogout() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await signOut();
    showAuthScreen();
  });
}

// ============================================================
// Main tabs (Settings / Stats)
// ============================================================

function setupMainTabs() {
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.main-panel').forEach(p => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.remove('hidden');

      if (tab.dataset.target === 'saved-panel') loadSavedPanel();
    });
  });
}

// ============================================================
// Settings
// ============================================================

function setupSettingsControls() {
  const keySelect     = document.getElementById('confirm-key-select');
  const customWrap    = document.getElementById('custom-key-wrap');
  const customDisplay = document.getElementById('custom-key-display');
  const customCode    = document.getElementById('custom-key-code');
  const preview       = document.getElementById('highlight-preview');

  // Swatch click handlers
  function setupSwatches(groupId) {
    document.querySelectorAll(`#${groupId} .swatch`).forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`#${groupId} .swatch`).forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        updatePreview();
      });
    });
  }
  setupSwatches('highlight-swatches');
  setupSwatches('text-swatches');

  function updatePreview() {
    preview.style.backgroundColor = getSwatchColor('highlight-swatches');
    preview.style.color           = getSwatchColor('text-swatches');
  }

  keySelect.addEventListener('change', () => {
    if (keySelect.value === 'custom') {
      customWrap.classList.remove('hidden');
      customDisplay.focus();
    } else {
      customWrap.classList.add('hidden');
    }
  });

  // Capture custom key
  customDisplay.addEventListener('keydown', e => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    customCode.value    = e.code;
    customDisplay.value = formatKeyCode(e.code);
  });

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    let confirmKey = keySelect.value;
    if (confirmKey === 'custom') {
      confirmKey = customCode.value;
      if (!confirmKey) { alert('Please press a key in the custom key field.'); return; }
    }

    const settings = {
      highlightColor: getSwatchColor('highlight-swatches'),
      textColor:      getSwatchColor('text-swatches'),
      confirmKey
    };

    await saveSettings(settings);

    // Notify active content scripts immediately
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
    });

    const successEl = document.getElementById('save-success');
    successEl.classList.remove('hidden');
    setTimeout(() => successEl.classList.add('hidden'), 2000);
  });
}

function getSwatchColor(groupId) {
  const active = document.querySelector(`#${groupId} .swatch.active`);
  return active ? active.dataset.color : null;
}

function selectSwatch(groupId, color) {
  let matched = false;
  document.querySelectorAll(`#${groupId} .swatch`).forEach(s => {
    const match = s.dataset.color.toLowerCase() === color.toLowerCase();
    s.classList.toggle('active', match);
    if (match) matched = true;
  });
  // If stored color isn't in the palette, fall back to the first swatch
  if (!matched) {
    const first = document.querySelector(`#${groupId} .swatch`);
    if (first) first.classList.add('active');
  }
}

async function loadAndApplySettings() {
  const s = await getSettings();

  // Select the right swatches (falls back to first if color not in palette)
  selectSwatch('highlight-swatches', s.highlightColor || '#FFFF00');
  selectSwatch('text-swatches',      s.textColor      || '#000000');

  // Set confirm key dropdown
  const select = document.getElementById('confirm-key-select');
  const knownOptions = Array.from(select.options).map(o => o.value).filter(v => v !== 'custom');

  if (knownOptions.includes(s.confirmKey)) {
    select.value = s.confirmKey;
  } else if (s.confirmKey) {
    select.value = 'custom';
    document.getElementById('custom-key-wrap').classList.remove('hidden');
    document.getElementById('custom-key-display').value = formatKeyCode(s.confirmKey);
    document.getElementById('custom-key-code').value    = s.confirmKey;
  }

  // Update preview
  const preview = document.getElementById('highlight-preview');
  preview.style.backgroundColor = s.highlightColor || '#FFFF00';
  preview.style.color            = s.textColor      || '#000000';
}

function formatKeyCode(code) {
  if (!code) return '';
  const map = {
    Space: 'Space', Enter: 'Enter', Period: '.', Backquote: '`',
    KeyA:'A', KeyB:'B', KeyC:'C', KeyD:'D', KeyE:'E', KeyF:'F',
    KeyG:'G', KeyH:'H', KeyI:'I', KeyJ:'J', KeyK:'K', KeyL:'L',
    KeyM:'M', KeyN:'N', KeyO:'O', KeyP:'P', KeyQ:'Q', KeyR:'R',
    KeyS:'S', KeyT:'T', KeyU:'U', KeyV:'V', KeyW:'W', KeyX:'X',
    KeyY:'Y', KeyZ:'Z',
    Digit0:'0',Digit1:'1',Digit2:'2',Digit3:'3',Digit4:'4',
    Digit5:'5',Digit6:'6',Digit7:'7',Digit8:'8',Digit9:'9'
  };
  return map[code] || code;
}

// ============================================================
// Saved Pages
// ============================================================

let currentTabInfo = null; // { url, title } — populated when Saved panel opens

function setupSavedPanel() {
  document.getElementById('save-page-btn').addEventListener('click', async () => {
    if (!currentTabInfo || !currentTabInfo.url) return;

    const customTitle = document.getElementById('save-custom-title').value.trim();
    const note        = document.getElementById('save-note').value.trim();
    const page = {
      id: genId(),
      url: currentTabInfo.url,
      title: customTitle || currentTabInfo.title || currentTabInfo.url,
      note,
      savedAt: new Date().toISOString()
    };

    const btn = document.getElementById('save-page-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    chrome.runtime.sendMessage({ type: 'SAVE_PAGE', page }, () => {
      btn.disabled = false;
      btn.textContent = 'Save This Page';
      document.getElementById('save-custom-title').value = '';
      document.getElementById('save-note').value = '';

      // Show "Already saved" badge and refresh list
      const msg = document.getElementById('already-saved-msg');
      msg.classList.remove('hidden');
      setTimeout(() => msg.classList.add('hidden'), 3000);

      loadSavedList();
    });
  });
}

async function loadSavedPanel() {
  // Fill in current page info
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];

  if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    currentTabInfo = { url: tab.url, title: tab.title };

    document.getElementById('current-title').textContent    = tab.title || tab.url;
    document.getElementById('current-url').textContent      = (() => {
      try { return new URL(tab.url).hostname; } catch (_) { return tab.url; }
    })();
    document.getElementById('save-custom-title').value      = tab.title || '';

    const faviconEl = document.getElementById('save-favicon');
    try {
      const domain = new URL(tab.url).hostname;
      faviconEl.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      faviconEl.style.display = 'block';
    } catch (_) {
      faviconEl.style.display = 'none';
    }

    document.getElementById('save-page-btn').disabled = false;
  } else {
    currentTabInfo = null;
    document.getElementById('current-title').textContent = 'No page selected';
    document.getElementById('current-url').textContent   = 'Open a webpage first';
    document.getElementById('save-page-btn').disabled    = true;
    document.getElementById('save-favicon').style.display = 'none';
  }

  document.getElementById('already-saved-msg').classList.add('hidden');
  loadSavedList();
}

function loadSavedList() {
  chrome.runtime.sendMessage({ type: 'GET_SAVED_PAGES' }, pages => {
    renderSavedList(Array.isArray(pages) ? pages : []);
  });
}

function renderSavedList(pages) {
  const list    = document.getElementById('saved-list');
  const countEl = document.getElementById('saved-count');

  countEl.textContent = pages.length > 0 ? `${pages.length}` : '';

  if (pages.length === 0) {
    list.innerHTML = '<li class="saved-empty">No pages saved yet</li>';
    return;
  }

  // Sort newest first
  const sorted = [...pages].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  list.innerHTML = sorted.map(page => {
    const domain  = (() => { try { return new URL(page.url).hostname; } catch (_) { return page.url; } })();
    const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=28`;
    const dateStr = formatSavedDate(page.savedAt);
    const noteHtml = page.note
      ? `<div class="saved-item-note">${escapeHtml(page.note)}</div>`
      : '';

    return `
      <li class="saved-item" data-id="${escapeHtml(page.id)}" data-url="${escapeHtml(page.url)}">
        <div class="saved-item-top">
          <img class="saved-item-favicon"
               src="${favicon}"
               onerror="this.style.display='none'"
               alt="">
          <div class="saved-item-info">
            <div class="saved-item-title" title="${escapeHtml(page.title)}">${escapeHtml(truncate(page.title, 48))}</div>
            <div class="saved-item-meta">
              <span class="saved-item-domain">${escapeHtml(domain)}</span>
              <span class="saved-item-date">${dateStr}</span>
            </div>
          </div>
          <button class="saved-item-delete" title="Remove" aria-label="Remove">✕</button>
        </div>
        ${noteHtml}
        <button class="saved-item-open">Open page →</button>
      </li>`;
  }).join('');

  // Wire up buttons
  list.querySelectorAll('.saved-item-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.closest('.saved-item').dataset.url;
      chrome.tabs.create({ url });
    });
  });

  list.querySelectorAll('.saved-item-title').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.closest('.saved-item').dataset.url;
      chrome.tabs.create({ url });
    });
  });

  list.querySelectorAll('.saved-item-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.saved-item');
      const id   = item.dataset.id;
      chrome.runtime.sendMessage({ type: 'DELETE_SAVED_PAGE', id }, () => {
        item.style.opacity = '0';
        item.style.transition = 'opacity 0.2s';
        setTimeout(() => { item.remove(); syncSavedCount(); }, 200);
      });
    });
  });
}

function syncSavedCount() {
  const remaining = document.querySelectorAll('#saved-list .saved-item').length;
  document.getElementById('saved-count').textContent = remaining > 0 ? `${remaining}` : '';
  if (remaining === 0) {
    document.getElementById('saved-list').innerHTML = '<li class="saved-empty">No pages saved yet</li>';
  }
}

// ============================================================
// Helpers
// ============================================================

function formatSavedDate(isoString) {
  if (!isoString) return '';
  const d     = new Date(isoString);
  const now   = new Date();
  const isToday     = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  const isThisYear  = d.getFullYear() === now.getFullYear();

  if (isToday) {
    return 'Today ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (isYesterday) return 'Yesterday';
  if (isThisYear) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ============================================================
// Boot — ALL functions are defined above, so this runs safely
// Uses readyState check so it works whether DOM is ready or not
// ============================================================

async function initPopup() {
  setupAuthTabs();
  setupMainTabs();
  setupAuthButtons();
  setupSettingsControls();
  setupSavedPanel();
  setupLogout();

  const user = await getCurrentUser();
  if (user) {
    showMainScreen(user);
  } else {
    showAuthScreen();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPopup);
} else {
  initPopup();
}
