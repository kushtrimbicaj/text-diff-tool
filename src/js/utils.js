/**
 * utils.js — small, reusable helpers. Nothing here runs at import time, so the
 * module is safe to import in a non-browser environment (e.g. the test runner).
 */
import { splitLines } from './diff.js';

/** Characters and lines for the live counters under each textarea. */
export function countText(text) {
  return { characters: text.length, lines: splitLines(text).lines.length };
}

export function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

/** Returns a debounced wrapper with a `.cancel()` method. */
export function debounce(fn, delayMs) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/** "text-diff-report-2026-10-26-2305.txt" (local time). */
export function reportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `text-diff-report-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}

/** True on macOS / iOS, used to show ⌘ instead of Ctrl in the shortcut hint. */
export function isApplePlatform(nav = globalThis.navigator) {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Copy text to the clipboard. Uses the async Clipboard API when available and
 * falls back to a temporary textarea + execCommand otherwise (e.g. file://).
 * @throws {Error} when neither method works
 */
export async function copyToClipboard(text) {
  if (globalThis.navigator?.clipboard?.writeText && globalThis.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    helper.remove();
  }
  if (!copied) throw new Error('Clipboard is not available');
}

/**
 * Offer `text` as a file download.
 * @throws {Error} when the browser cannot create the download
 */
export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Plain-text report for the "Download" action: a short summary followed by the
 * exact unified diff that the Copy action produces.
 */
export function buildReport({ unifiedText, stats, options, generatedAt = new Date() }) {
  const yesNo = (flag) => (flag ? 'on' : 'off');
  const header = [
    'Text Diff Report',
    '================',
    `Generated:         ${generatedAt.toISOString()}`,
    `Ignore whitespace: ${yesNo(options.ignoreWhitespace)}`,
    `Ignore case:       ${yesNo(options.ignoreCase)}`,
    '',
    `Original lines:    ${stats.originalLines}`,
    `Modified lines:    ${stats.modifiedLines}`,
    `Added lines:       ${stats.added}`,
    `Removed lines:     ${stats.removed}`,
    `Unchanged lines:   ${stats.unchanged}`,
    `Line similarity:   ${stats.similarity}%  (2 x unchanged / (original + modified))`,
    '',
  ];
  const body = unifiedText === '' ? ['No differences found.', ''] : [unifiedText];
  return header.concat(body).join('\n');
}
