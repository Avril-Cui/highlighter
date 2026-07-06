// ============================================================
// popup.js — Popup logic (auth, settings, stats)
// ============================================================

'use strict';

// ============================================================
// Boot — decide which screen to show
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  setupAuthTabs();
  setupMainTabs();
  setupAuthButtons();
  setupSettingsControls();
  setupLogout();

  const user = await getCurrentUser();
  if (user) {
    showMainScreen(user);
  } else {
    showAuthScreen();
  }
});

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
  loadStats();
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

      if (tab.dataset.target === 'stats-panel') loadStats();
    });
  });
}

// ============================================================
// Settings
// ============================================================

function setupSettingsControls() {
  const hlColor   = document.getElementById('highlight-color');
  const txtColor  = document.getElementById('text-color');
  const keySelect = document.getElementById('confirm-key-select');
  const customWrap = document.getElementById('custom-key-wrap');
  const customDisplay = document.getElementById('custom-key-display');
  const customCode = document.getElementById('custom-key-code');
  const preview   = document.getElementById('highlight-preview');

  function updatePreview() {
    preview.style.backgroundColor = hlColor.value;
    preview.style.color = txtColor.value;
  }

  hlColor.addEventListener('input', updatePreview);
  txtColor.addEventListener('input', updatePreview);

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
    // Ignore modifier-only keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    customCode.value = e.code;
    customDisplay.value = formatKeyCode(e.code);
  });

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    let confirmKey = keySelect.value;
    if (confirmKey === 'custom') {
      confirmKey = customCode.value;
      if (!confirmKey) { alert('Please press a key in the custom key field.'); return; }
    }

    const settings = {
      highlightColor: hlColor.value,
      textColor: txtColor.value,
      confirmKey
    };

    await saveSettings(settings);

    // Notify all active content scripts
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
    });

    const successEl = document.getElementById('save-success');
    successEl.classList.remove('hidden');
    setTimeout(() => successEl.classList.add('hidden'), 2000);
  });
}

async function loadAndApplySettings() {
  const s = await getSettings();

  document.getElementById('highlight-color').value = s.highlightColor || '#FFFF00';
  document.getElementById('text-color').value       = s.textColor      || '#000000';

  // Set confirm key dropdown
  const select = document.getElementById('confirm-key-select');
  const knownOptions = Array.from(select.options).map(o => o.value).filter(v => v !== 'custom');

  if (knownOptions.includes(s.confirmKey)) {
    select.value = s.confirmKey;
  } else if (s.confirmKey) {
    select.value = 'custom';
    document.getElementById('custom-key-wrap').classList.remove('hidden');
    document.getElementById('custom-key-display').value = formatKeyCode(s.confirmKey);
    document.getElementById('custom-key-code').value = s.confirmKey;
  }

  // Update preview
  const preview = document.getElementById('highlight-preview');
  preview.style.backgroundColor = s.highlightColor || '#FFFF00';
  preview.style.color = s.textColor || '#000000';
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
// Stats
// ============================================================

async function loadStats() {
  // Show today's date
  const today = new Date();
  document.getElementById('stats-date').textContent =
    today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Fetch stats from background
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, stats => {
    const pages = (stats?.pagesRead || []).length;
    const seconds = stats?.readingSeconds || 0;

    document.getElementById('stat-pages').textContent = pages;
    document.getElementById('stat-time').textContent  = formatDuration(seconds);

    // Recent pages list
    const list = document.getElementById('recent-list');
    const urls = (stats?.pagesRead || []).slice(-10).reverse();
    if (urls.length === 0) {
      list.innerHTML = '<li class="recent-empty">No pages recorded yet</li>';
    } else {
      list.innerHTML = urls.map(url => {
        try {
          const u = new URL(url);
          const label = u.hostname + (u.pathname !== '/' ? u.pathname.slice(0, 40) : '');
          return `<li title="${url}">${label}</li>`;
        } catch (_) {
          return `<li>${url.slice(0, 50)}</li>`;
        }
      }).join('');
    }
  });

  // Total highlights count
  chrome.runtime.sendMessage({ type: 'GET_HIGHLIGHT_COUNT' }, count => {
    document.getElementById('stat-highlights').textContent = count ?? '—';
  });
}

function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
