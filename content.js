// ============================================================
// content.js - Web Highlighter Content Script
// Handles text selection, highlight application, and removal
// ============================================================

'use strict';

let settings = {
  highlightColor: '#FFFF00',
  textColor: '#000000',
  confirmKey: 'Space'
};

const appliedIds = new Set();
let removeBtn = null;
let removeBtnTimer = null;

// ============================================================
// Boot
// ============================================================

function init() {
  loadSettings().then(restoreHighlights);
  document.addEventListener('keydown', handleKeyDown, true);
  chrome.runtime.onMessage.addListener(onMessage);
}

function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['settings'], result => {
      if (result.settings) Object.assign(settings, result.settings);
      resolve();
    });
  });
}

function onMessage(msg) {
  if (msg.type === 'SETTINGS_UPDATED') {
    Object.assign(settings, msg.settings);
  }
}

// ============================================================
// Restore saved highlights
// ============================================================

function restoreHighlights() {
  const url = getNormalizedUrl();
  chrome.runtime.sendMessage({ type: 'GET_HIGHLIGHTS', url }, highlights => {
    if (!Array.isArray(highlights)) return;
    // Apply in order; element-XPath method is stable regardless of order
    highlights.forEach(h => {
      if (!appliedIds.has(h.id)) applyStoredHighlight(h);
    });
  });
}

function applyStoredHighlight(h) {
  try {
    const range = deserializeRange(h);
    if (!range || range.collapsed) return;
    applyHighlightRange(range, h.id, h.color, h.textColor);
    appliedIds.add(h.id);
  } catch (e) {
    // Silently skip highlights that can't be restored
  }
}

// ============================================================
// Key handler
// ============================================================

function handleKeyDown(e) {
  // Never intercept inside form fields
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
    url: getNormalizedUrl(),
    text: serialized.text,
    startXPath: serialized.startXPath,
    startOffset: serialized.startOffset,
    endXPath: serialized.endXPath,
    endOffset: serialized.endOffset,
    color: settings.highlightColor,
    textColor: settings.textColor,
    createdAt: new Date().toISOString()
  };

  chrome.runtime.sendMessage({ type: 'SAVE_HIGHLIGHT', highlight });
}

// ============================================================
// Apply highlight to DOM
// ============================================================

function applyHighlightRange(range, id, color, textColor) {
  const nodes = collectTextNodes(range);
  nodes.forEach(({ node, start, end }) => {
    wrapFragment(node, start, end, id, color, textColor);
  });
}

function collectTextNodes(range) {
  const result = [];
  const ancestor = range.commonAncestorContainer;

  if (ancestor.nodeType === Node.TEXT_NODE) {
    // Entire selection is within one text node
    result.push({
      node: ancestor,
      start: range.startOffset,
      end: range.endOffset
    });
    return result;
  }

  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Accept text nodes that overlap with the range
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0) return NodeFilter.FILTER_REJECT;
      if (range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let node;
  while ((node = walker.nextNode())) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.textContent.length;
    if (start < end) result.push({ node, start, end });
  }

  return result;
}

function wrapFragment(textNode, start, end, id, color, textColor) {
  // Don't double-wrap
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
// Hover → remove button
// ============================================================

function attachHover(mark) {
  mark.addEventListener('mouseenter', showRemoveBtn);
  mark.addEventListener('mouseleave', () => scheduleHide(150));
}

function showRemoveBtn(e) {
  clearTimeout(removeBtnTimer);
  const mark = e.currentTarget;
  const id = mark.dataset.highlightId;

  // Reuse button if it's already for the same highlight
  if (removeBtn && removeBtn.dataset.forId === id) return;
  hideRemoveBtn();

  const btn = document.createElement('div');
  btn.className = 'wh-remove-btn';
  btn.dataset.forId = id;
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Remove highlight');
  btn.innerHTML = `<span class="wh-remove-x">✕</span> Remove`;

  const rect = mark.getBoundingClientRect();
  btn.style.top = `${rect.top + window.scrollY - 36}px`;
  btn.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;

  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    removeHighlight(id);
    hideRemoveBtn();
  });
  btn.addEventListener('mouseenter', () => clearTimeout(removeBtnTimer));
  btn.addEventListener('mouseleave', () => scheduleHide(150));

  document.body.appendChild(btn);
  removeBtn = btn;
}

function scheduleHide(ms) {
  removeBtnTimer = setTimeout(hideRemoveBtn, ms);
}

function hideRemoveBtn() {
  if (removeBtn) { removeBtn.remove(); removeBtn = null; }
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

  appliedIds.delete(id);
  chrome.runtime.sendMessage({ type: 'DELETE_HIGHLIGHT', id, url: getNormalizedUrl() });
}

// ============================================================
// Range serialization
// ============================================================

function serializeRange(range) {
  try {
    const startEl = toElement(range.startContainer);
    const endEl = toElement(range.endContainer);

    return {
      text: range.toString(),
      startXPath: elementXPath(startEl),
      startOffset: charOffsetInElement(startEl, range.startContainer, range.startOffset),
      endXPath: elementXPath(endEl),
      endOffset: charOffsetInElement(endEl, range.endContainer, range.endOffset)
    };
  } catch (_) {
    return null;
  }
}

function deserializeRange(h) {
  try {
    const startEl = evalXPath(h.startXPath);
    const endEl = evalXPath(h.endXPath);
    if (!startEl || !endEl) return fallbackTextSearch(h.text);

    const sp = findCharPosition(startEl, h.startOffset);
    const ep = findCharPosition(endEl, h.endOffset);
    if (!sp || !ep) return fallbackTextSearch(h.text);

    const range = document.createRange();
    range.setStart(sp.node, sp.offset);
    range.setEnd(ep.node, ep.offset);

    if (range.toString().trim() !== h.text.trim()) return fallbackTextSearch(h.text);
    return range;
  } catch (_) {
    return fallbackTextSearch(h.text);
  }
}

// Fallback: locate the first occurrence of the stored text string
function fallbackTextSearch(text) {
  if (!text || !text.trim()) return null;
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.classList.contains('wh-highlight')) continue;
      const idx = node.textContent.indexOf(text);
      if (idx !== -1 && idx + text.length <= node.textContent.length) {
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
  const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);

  if (sameTagSiblings.length === 1) {
    return `${elementXPath(parent)}/${tag}`;
  }
  const idx = sameTagSiblings.indexOf(el) + 1;
  return `${elementXPath(parent)}/${tag}[${idx}]`;
}

function evalXPath(xpath) {
  try {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (_) { return null; }
}

// Count characters from the beginning of `element`'s text content up to `node:offset`
function charOffsetInElement(element, targetNode, targetOffset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let count = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === targetNode) return count + targetOffset;
    count += node.textContent.length;
  }
  return count;
}

// Walk text nodes inside `element` to find the node+offset at `charOffset`
function findCharPosition(element, charOffset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = charOffset;
  let node;
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

// ============================================================
// Start
// ============================================================
init();
