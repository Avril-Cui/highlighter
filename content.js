// ============================================================
// content.js - Web Highlighter Content Script
// ============================================================

'use strict';

let settings = {
  highlightColor: '#FFFF00',
  textColor: '#000000',
  confirmKey: 'Space'
};

let currentTheme = 'dark';

const appliedIds    = new Set();
const highlightData = new Map(); // id → full highlight object (with comments)
const annotationEls = new Map(); // id → [annEl, ...]

// ============================================================
// Boot
// ============================================================

function init() {
  loadSettings().then(restoreHighlights);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mousedown', onDocumentMouseDown, true);
  window.addEventListener('scroll', onScroll, { passive: true });
  chrome.runtime.onMessage.addListener(onMessage);
}

function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['settings', 'theme'], result => {
      if (result.settings) Object.assign(settings, result.settings);
      currentTheme = result.theme || 'dark';
      resolve();
    });
  });
}

function onMessage(msg) {
  if (msg.type === 'SETTINGS_UPDATED') {
    Object.assign(settings, msg.settings);
  }
  if (msg.type === 'THEME_UPDATED') {
    currentTheme = msg.theme;
    const isLight = currentTheme === 'light';
    // Update all existing annotations
    document.querySelectorAll('.wh-annotation').forEach(ann => {
      ann.classList.toggle('wh-theme-light', isLight);
    });
    // Update open hover panel
    if (activePanel) activePanel.classList.toggle('wh-theme-light', isLight);
  }
}

function onDocumentMouseDown(e) {
  if (!activePanel) return;
  if (!activePanel.contains(e.target)) hidePanelNow();
}

// ============================================================
// Scroll: keep fixed annotations aligned with their highlights
// ============================================================

let rafPending = false;
function onScroll() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    document.querySelectorAll('.wh-annotation[data-doc-top]').forEach(ann => {
      const docTop = parseFloat(ann.dataset.docTop);
      if (!isNaN(docTop)) ann.style.top = `${docTop - window.scrollY}px`;
    });
  });
}

// ============================================================
// Restore saved highlights + their annotations
// ============================================================

function restoreHighlights() {
  const url = getNormalizedUrl();
  chrome.runtime.sendMessage({ type: 'GET_HIGHLIGHTS', url }, highlights => {
    if (!Array.isArray(highlights)) return;
    highlights.forEach(h => {
      highlightData.set(h.id, h);
      if (!appliedIds.has(h.id)) applyStoredHighlight(h);
      renderAnnotations(h); // show all existing comments as side annotations
    });
  });
}

function applyStoredHighlight(h) {
  try {
    const range = deserializeRange(h);
    if (!range || range.collapsed) return;
    applyHighlightRange(range, h.id, h.color, h.textColor);
    appliedIds.add(h.id);
  } catch (_) {}
}

// ============================================================
// Key handler
// ============================================================

function handleKeyDown(e) {
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.isContentEditable || t.closest('[contenteditable="true"]')) return;

  if (e.code !== settings.confirmKey) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

  e.preventDefault();
  e.stopPropagation();

  const range = sel.getRangeAt(0).cloneRange();
  sel.removeAllRanges();
  createHighlight(range);
}

// ============================================================
// Create highlight
// ============================================================

function createHighlight(range) {
  const id = genId();
  const serialized = serializeRange(range);
  if (!serialized) return;

  applyHighlightRange(range, id, settings.highlightColor, settings.textColor);
  appliedIds.add(id);

  const highlight = {
    id,
    url:         getNormalizedUrl(),
    text:        serialized.text,
    startXPath:  serialized.startXPath,
    startOffset: serialized.startOffset,
    endXPath:    serialized.endXPath,
    endOffset:   serialized.endOffset,
    color:       settings.highlightColor,
    textColor:   settings.textColor,
    createdAt:   new Date().toISOString(),
    comments:    []
  };

  highlightData.set(id, highlight);
  chrome.runtime.sendMessage({ type: 'SAVE_HIGHLIGHT', highlight });
}

// ============================================================
// Apply highlight to DOM
// ============================================================

function applyHighlightRange(range, id, color, textColor) {
  collectTextNodes(range).forEach(({ node, start, end }) => {
    wrapFragment(node, start, end, id, color, textColor);
  });
}

function collectTextNodes(range) {
  const result = [];
  const ancestor = range.commonAncestorContainer;

  if (ancestor.nodeType === Node.TEXT_NODE) {
    result.push({ node: ancestor, start: range.startOffset, end: range.endOffset });
    return result;
  }

  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const nr = document.createRange();
      nr.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.END_TO_START, nr) >= 0) return NodeFilter.FILTER_REJECT;
      if (range.compareBoundaryPoints(Range.START_TO_END, nr) <= 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node;
  while ((node = walker.nextNode())) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end   = node === range.endContainer   ? range.endOffset   : node.textContent.length;
    if (start < end) result.push({ node, start, end });
  }
  return result;
}

function wrapFragment(textNode, start, end, id, color, textColor) {
  if (textNode.parentElement?.dataset.highlightId) return;

  const len = textNode.textContent.length;
  if (end < len) textNode.splitText(end);
  const target = start > 0 ? textNode.splitText(start) : textNode;

  const mark = document.createElement('mark');
  mark.className = 'wh-highlight';
  mark.dataset.highlightId = id;
  mark.style.backgroundColor = color;
  if (textColor && textColor !== '#000000') mark.style.color = textColor;

  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
  attachHover(mark);
}

// ============================================================
// Persistent side annotations
// ============================================================

function renderAnnotations(highlight) {
  // Remove stale elements for this highlight
  (annotationEls.get(highlight.id) || []).forEach(el => el.remove());
  annotationEls.delete(highlight.id);

  const comments = highlight.comments || [];
  if (!comments.length) return;

  const marks = document.querySelectorAll(`.wh-highlight[data-highlight-id="${highlight.id}"]`);
  if (!marks.length) return;

  const baseDocTop = marks[0].getBoundingClientRect().top + window.scrollY;
  const newEls = [];
  let docTop = baseDocTop;

  comments.forEach(comment => {
    const ann = createAnnotationEl(highlight.id, comment);
    ann.dataset.docTop = docTop;
    ann.style.top = `${docTop - window.scrollY}px`;
    document.body.appendChild(ann);
    newEls.push(ann);
    // Stack next annotation below this one (offsetHeight triggers layout sync)
    docTop += (ann.offsetHeight || 56) + 5;
  });

  annotationEls.set(highlight.id, newEls);
}

function createAnnotationEl(highlightId, comment) {
  const ann = document.createElement('div');
  ann.className = 'wh-annotation' + (currentTheme === 'light' ? ' wh-theme-light' : '');
  ann.dataset.highlightId = highlightId;
  ann.dataset.commentId   = comment.id;
  ann.style.cssText = 'position:fixed; right:8px;';

  ann.innerHTML = `
    <div class="wh-ann-content">
      <p class="wh-ann-text">${escHtml(comment.text)}</p>
      <button class="wh-ann-del" aria-label="Delete comment">✕</button>
    </div>`;

  ann.querySelector('.wh-ann-del').addEventListener('click', e => {
    e.stopPropagation();
    deleteComment(highlightId, comment.id);
  });

  return ann;
}

function addAnnotationEl(highlightId, comment) {
  const marks = document.querySelectorAll(`.wh-highlight[data-highlight-id="${highlightId}"]`);
  if (!marks.length) return;

  const existing = annotationEls.get(highlightId) || [];

  let docTop;
  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    docTop = parseFloat(last.dataset.docTop) + (last.offsetHeight || 56) + 5;
  } else {
    docTop = marks[0].getBoundingClientRect().top + window.scrollY;
  }

  const ann = createAnnotationEl(highlightId, comment);
  ann.dataset.docTop = docTop;
  ann.style.top = `${docTop - window.scrollY}px`;
  document.body.appendChild(ann);

  existing.push(ann);
  annotationEls.set(highlightId, existing);
}

function removeAnnotationEl(highlightId, commentId) {
  const existing = annotationEls.get(highlightId) || [];
  const idx = existing.findIndex(el => el.dataset.commentId === commentId);
  if (idx === -1) return;
  existing[idx].remove();
  existing.splice(idx, 1);
  annotationEls.set(highlightId, existing);
  repositionAnnotations(highlightId);
}

function repositionAnnotations(highlightId) {
  const existing = annotationEls.get(highlightId) || [];
  if (!existing.length) return;

  const marks = document.querySelectorAll(`.wh-highlight[data-highlight-id="${highlightId}"]`);
  if (!marks.length) return;

  let docTop = marks[0].getBoundingClientRect().top + window.scrollY;
  existing.forEach(ann => {
    ann.dataset.docTop = docTop;
    ann.style.top = `${docTop - window.scrollY}px`;
    docTop += (ann.offsetHeight || 56) + 5;
  });
}

// ============================================================
// Hover → add-comment panel (no list, comments shown as annotations)
// ============================================================

let activePanel   = null;
let activePanelId = null;
let panelHideTimer = null;

function attachHover(mark) {
  mark.addEventListener('mouseenter', () => showCommentPanel(mark));
  mark.addEventListener('mouseleave', () => schedulePanelHide(250));
}

function showCommentPanel(mark) {
  clearTimeout(panelHideTimer);
  const id = mark.dataset.highlightId;

  if (activePanel && activePanelId === id) return;
  hidePanelNow();

  const panel = buildPanel(id);

  const rect = mark.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.right    = '8px';
  panel.style.left     = 'auto';
  // Align with the mark, but shift down enough to not overlap annotations
  panel.style.top      = `${Math.max(8, rect.top)}px`;

  panel.addEventListener('mouseenter', () => clearTimeout(panelHideTimer));
  panel.addEventListener('mouseleave', () => schedulePanelHide(250));

  document.body.appendChild(panel);
  activePanel   = panel;
  activePanelId = id;

  // Nudge upward if it would overflow the viewport bottom
  requestAnimationFrame(() => {
    const pr = panel.getBoundingClientRect();
    const vh = document.documentElement.clientHeight;
    if (pr.bottom > vh - 8) {
      panel.style.top = `${Math.max(8, vh - pr.height - 8)}px`;
    }
  });
}

function buildPanel(id) {
  const panel = document.createElement('div');
  panel.className    = 'wh-comment-panel' + (currentTheme === 'light' ? ' wh-theme-light' : '');
  panel.dataset.forId = id;

  panel.innerHTML = `
    <div class="wh-panel-header">
      <span class="wh-panel-title">Add comment</span>
      <button class="wh-panel-close" aria-label="Close">✕</button>
    </div>
    <div class="wh-comment-form">
      <textarea class="wh-comment-textarea"
                placeholder="Write a comment… (Ctrl+Enter to submit)"
                rows="2"></textarea>
      <div class="wh-comment-actions">
        <button class="wh-btn-add-comment">Add</button>
        <button class="wh-btn-remove-hl">Remove highlight</button>
      </div>
    </div>`;

  panel.querySelector('.wh-panel-close').addEventListener('click', e => {
    e.stopPropagation();
    hidePanelNow();
  });

  const textarea = panel.querySelector('.wh-comment-textarea');
  textarea.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitComment(id, textarea);
    }
  });

  panel.querySelector('.wh-btn-add-comment').addEventListener('click', e => {
    e.stopPropagation();
    submitComment(id, textarea);
  });

  panel.querySelector('.wh-btn-remove-hl').addEventListener('click', e => {
    e.stopPropagation();
    removeHighlight(id);
    hidePanelNow();
  });

  return panel;
}

function submitComment(highlightId, textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  const comment = { id: genId(), text, createdAt: new Date().toISOString() };
  textarea.value    = '';
  textarea.disabled = true;

  chrome.runtime.sendMessage(
    { type: 'ADD_COMMENT', highlightId, url: getNormalizedUrl(), comment },
    response => {
      textarea.disabled = false;
      if (response && response.success) {
        const h = highlightData.get(highlightId);
        if (h) h.comments = response.comments;
        addAnnotationEl(highlightId, comment);
      }
      requestAnimationFrame(() => textarea.focus());
    }
  );
}

function deleteComment(highlightId, commentId) {
  chrome.runtime.sendMessage(
    { type: 'DELETE_COMMENT', highlightId, url: getNormalizedUrl(), commentId },
    response => {
      if (response && response.success) {
        const h = highlightData.get(highlightId);
        if (h) h.comments = response.comments;
        removeAnnotationEl(highlightId, commentId);
      }
    }
  );
}

function schedulePanelHide(ms) {
  panelHideTimer = setTimeout(hidePanelNow, ms);
}

function hidePanelNow() {
  clearTimeout(panelHideTimer);
  if (activePanel) { activePanel.remove(); activePanel = null; activePanelId = null; }
}

// ============================================================
// Remove highlight
// ============================================================

function removeHighlight(id) {
  document.querySelectorAll(`.wh-highlight[data-highlight-id="${id}"]`).forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  });

  // Remove all annotations for this highlight
  (annotationEls.get(id) || []).forEach(el => el.remove());
  annotationEls.delete(id);

  appliedIds.delete(id);
  highlightData.delete(id);
  chrome.runtime.sendMessage({ type: 'DELETE_HIGHLIGHT', id, url: getNormalizedUrl() });
}

// ============================================================
// Range serialization
// ============================================================

function serializeRange(range) {
  try {
    const startEl = toElement(range.startContainer);
    const endEl   = toElement(range.endContainer);
    return {
      text:        range.toString(),
      startXPath:  elementXPath(startEl),
      startOffset: charOffsetInElement(startEl, range.startContainer, range.startOffset),
      endXPath:    elementXPath(endEl),
      endOffset:   charOffsetInElement(endEl, range.endContainer, range.endOffset)
    };
  } catch (_) { return null; }
}

function deserializeRange(h) {
  try {
    const startEl = evalXPath(h.startXPath);
    const endEl   = evalXPath(h.endXPath);
    if (!startEl || !endEl) return fallbackTextSearch(h.text);

    const sp = findCharPosition(startEl, h.startOffset);
    const ep = findCharPosition(endEl,   h.endOffset);
    if (!sp || !ep) return fallbackTextSearch(h.text);

    const range = document.createRange();
    range.setStart(sp.node, sp.offset);
    range.setEnd(ep.node,   ep.offset);

    if (range.toString().trim() !== h.text.trim()) return fallbackTextSearch(h.text);
    return range;
  } catch (_) { return fallbackTextSearch(h.text); }
}

function fallbackTextSearch(text) {
  if (!text || !text.trim()) return null;
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.classList.contains('wh-highlight')) continue;
      const idx = node.textContent.indexOf(text);
      if (idx !== -1) {
        const r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + text.length);
        return r;
      }
    }
  } catch (_) {}
  return null;
}

// ============================================================
// XPath / position utilities
// ============================================================

function toElement(node) {
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function elementXPath(el) {
  if (!el || el === document.documentElement) return '//html';
  if (el === document.body) return '//body';

  if (el.id) {
    const escaped = el.id.replace(/"/g, '\\"');
    if (document.querySelectorAll(`[id="${el.id}"]`).length === 1) {
      return `//*[@id="${escaped}"]`;
    }
  }

  const parent = el.parentElement;
  if (!parent) return '//html';

  const tag = el.tagName.toLowerCase();
  const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
  if (siblings.length === 1) return `${elementXPath(parent)}/${tag}`;
  return `${elementXPath(parent)}/${tag}[${siblings.indexOf(el) + 1}]`;
}

function evalXPath(xpath) {
  try {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (_) { return null; }
}

function charOffsetInElement(element, targetNode, targetOffset) {
  // Use a Range to measure character distance from element start to
  // (targetNode, targetOffset). This correctly handles both element-node
  // containers (where targetOffset is a child index) and text-node containers
  // (where targetOffset is a character offset within the text node).
  // The old TreeWalker approach failed when targetNode === element itself
  // (e.g. triple-click selection), returning total text length instead of 0.
  const r = document.createRange();
  r.setStart(element, 0);
  r.setEnd(targetNode, targetOffset);
  return r.toString().length;
}

function findCharPosition(element, charOffset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = charOffset, node;
  while ((node = walker.nextNode())) {
    if (remaining <= node.textContent.length) return { node, offset: remaining };
    remaining -= node.textContent.length;
  }
  if (node) return { node, offset: node.textContent.length };
  return null;
}

// ============================================================
// Misc helpers
// ============================================================

function getNormalizedUrl() {
  const u = new URL(window.location.href);
  u.hash = '';
  return u.toString();
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// Start
// ============================================================
init();
