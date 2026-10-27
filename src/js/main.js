/**
 * main.js — application entry point: owns state, wires events, and
 * coordinates diff.js (computation), stats.js, render.js (DOM) and utils.js.
 *
 * Privacy: nothing in this app performs a network request, and user text is
 * never written to the console or to storage (only the theme choice is saved).
 */
import { diffLines, formatUnified, DiffLimitError, MAX_LINES_PER_SIDE } from './diff.js';
import { computeStats } from './stats.js';
import {
  renderMessage,
  renderStats,
  renderSideBySide,
  renderUnified,
  createNotice,
} from './render.js';
import {
  buildReport,
  copyToClipboard,
  countText,
  debounce,
  downloadTextFile,
  formatNumber,
  isApplePlatform,
  reportFilename,
} from './utils.js';

const THEME_KEY = 'text-diff-tool:theme'; // must match bootstrap.js
const THEME_COLORS = { dark: '#0a0d14', light: '#f4f6fb' };
const AUTO_COMPARE_DELAY_MS = 350;
const LARGE_INPUT_CHARS = 100000; // above this we show a "comparing…" state first
const TOAST_DURATION_MS = 4000;

const $ = (id) => document.getElementById(id);

const els = {
  original: $('originalText'),
  modified: $('modifiedText'),
  originalCounts: $('originalCounts'),
  modifiedCounts: $('modifiedCounts'),
  clearOriginal: $('clearOriginal'),
  clearModified: $('clearModified'),
  compare: $('compareBtn'),
  swap: $('swapBtn'),
  example: $('exampleBtn'),
  clearAll: $('clearAllBtn'),
  ignoreWhitespace: $('ignoreWhitespace'),
  ignoreCase: $('ignoreCase'),
  autoCompare: $('autoCompare'),
  copy: $('copyBtn'),
  download: $('downloadBtn'),
  output: $('output'),
  stats: $('stats'),
  stale: $('staleNotice'),
  status: $('status'),
  toast: $('toast'),
  themeToggle: $('themeToggle'),
  shortcutHint: $('shortcutHint'),
  limitsNote: $('limitsNote'),
  viewRadios: document.querySelectorAll('input[name="view"]'),
};

/** Everything the UI needs to re-render without recomputing the diff. */
const state = {
  view: 'side-by-side',
  result: null, // last diff result, or null
  unifiedText: '',
  stats: null,
  options: { ignoreWhitespace: false, ignoreCase: false }, // options used for `result`
  runToken: 0, // lets a newer comparison cancel an older pending one
};

/* --------------------------------- example -------------------------------- */

const EXAMPLE_ORIGINAL = [
  '// Shopping cart helpers',
  'const TAX_RATE = 0.2;',
  '',
  'function calculateTotal(items) {',
  '  let total = 0;',
  '  for (let i = 0; i < items.length; i++) {',
  '    total += items[i].price;',
  '  }',
  '  return total;',
  '}',
  '',
  'function formatPrice(value) {',
  '  return "$" + value.toFixed(2);',
  '}',
  '',
  'console.log(formatPrice(calculateTotal(cart)));',
  '',
].join('\n');

const EXAMPLE_MODIFIED = [
  '// Shopping cart helpers',
  'const tax_rate = 0.2;',
  'const FREE_SHIPPING_THRESHOLD = 50;',
  '',
  'function calculateTotal(items, discount = 0) {',
  '  const subtotal = items.reduce((sum, item) => sum + item.price, 0);',
  '  return subtotal - discount;',
  '}',
  '',
  'function formatPrice(value) {',
  '  return `$${value.toFixed(2)}`;',
  '}',
  '',
  'function qualifiesForFreeShipping(total) {',
  '  return total >= FREE_SHIPPING_THRESHOLD;',
  '}',
  '',
  'console.log(formatPrice(calculateTotal(cart)));',
  '',
].join('\n');

/* ---------------------------------- theme --------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null; // storage can be unavailable (private mode, blocked cookies)
  }
}

function initTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* the choice still applies for this visit */
    }
  });

  // Follow the OS setting live, but only until the user makes an explicit choice.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
  });
}

/* ------------------------------ small UI helpers --------------------------- */

function announce(message) {
  // Clear first so repeating the same message is still announced.
  els.status.textContent = '';
  requestAnimationFrame(() => {
    els.status.textContent = message;
  });
}

let toastTimer = null;
function showToast(message, tone = 'success') {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast toast-${tone}`;
  els.toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, TOAST_DURATION_MS);
  if (tone !== 'error') announce(message);
}

function readOptions() {
  return { ignoreWhitespace: els.ignoreWhitespace.checked, ignoreCase: els.ignoreCase.checked };
}

function plural(count, word) {
  return `${formatNumber(count)} ${word}${count === 1 ? '' : 's'}`;
}

function updateCounts() {
  for (const [textarea, target] of [
    [els.original, els.originalCounts],
    [els.modified, els.modifiedCounts],
  ]) {
    const { characters, lines } = countText(textarea.value);
    target.textContent = `${plural(characters, 'character')} · ${plural(lines, 'line')}`;
  }
}

function setStale(isStale) {
  els.stale.hidden = !isStale;
}

function setBusy(isBusy) {
  els.output.setAttribute('aria-busy', String(isBusy));
  els.compare.disabled = isBusy;
  els.compare.classList.toggle('is-busy', isBusy);
}

function setResultActionsEnabled() {
  els.copy.disabled = state.unifiedText === '';
  els.download.disabled = state.result === null;
}

/* -------------------------------- comparing -------------------------------- */

function resetResult() {
  state.result = null;
  state.stats = null;
  state.unifiedText = '';
  renderStats(els.stats, null);
  setResultActionsEnabled();
  setStale(false);
}

function showEmptyState() {
  resetResult();
  renderMessage(els.output, {
    title: 'No comparison yet',
    body: 'Paste text into both panels and choose Compare Texts, or load the example to see how it works.',
  });
}

function renderResult() {
  const { result } = state;
  if (!result) return;

  if (!result.hasChanges) {
    const note = result.options.ignoreWhitespace || result.options.ignoreCase
      ? 'The texts match once the selected ignore options are applied.'
      : 'Both texts are identical.';
    renderMessage(els.output, { title: 'No differences found', body: note, tone: 'success' });
    return;
  }

  if (state.view === 'unified') renderUnified(els.output, result);
  else renderSideBySide(els.output, result);

  if (result.approximate) {
    els.output.prepend(
      createNotice(
        'These texts are too different to align line by line within the size budget, so the changed region is shown as fully replaced. The result is valid but not minimal.',
        'warn'
      )
    );
  }
}

function summaryMessage(stats, result) {
  if (!result.hasChanges) return 'Comparison complete. No differences found.';
  if (stats.added === 0 && stats.removed === 0) {
    return 'Comparison complete. Only the trailing newline differs.';
  }
  return `Comparison complete. ${plural(stats.added, 'line')} added, ${plural(stats.removed, 'line')} removed, ${plural(stats.unchanged, 'line')} unchanged.`;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function compare() {
  debouncedCompare.cancel();
  const token = ++state.runToken;
  const originalText = els.original.value;
  const modifiedText = els.modified.value;

  if (originalText === '' && modifiedText === '') {
    resetResult();
    renderMessage(els.output, {
      title: 'Both inputs are empty',
      body: 'Enter or paste text in the Original and Modified panels, then compare.',
    });
    announce('Both inputs are empty. Enter text to compare.');
    return;
  }

  const options = readOptions();
  const isLarge = originalText.length + modifiedText.length > LARGE_INPUT_CHARS;
  setBusy(false);
  if (isLarge) {
    setBusy(true);
    announce('Comparing large text…');
    await pause(30); // let the browser paint the busy state before the CPU-heavy part
    if (token !== state.runToken) return; // a newer comparison took over
  }

  try {
    const result = diffLines(originalText, modifiedText, options);
    state.result = result;
    state.options = options;
    state.stats = computeStats(result);
    state.unifiedText = formatUnified(result);
    renderStats(els.stats, state.stats);
    renderResult();
    setResultActionsEnabled();
    setStale(false);
    announce(summaryMessage(state.stats, result));
  } catch (error) {
    resetResult();
    const isLimit = error instanceof DiffLimitError;
    renderMessage(els.output, {
      title: isLimit ? 'Input is too large' : 'Could not compare these texts',
      body: isLimit
        ? `${error.message} Split the text into smaller parts and compare them separately.`
        : 'Something went wrong while comparing. Try again, or reload the page if the problem persists.',
      tone: 'error',
    });
    announce(isLimit ? error.message : 'Could not compare these texts.');
  } finally {
    if (isLarge && token === state.runToken) setBusy(false);
  }
}

const debouncedCompare = debounce(compare, AUTO_COMPARE_DELAY_MS);

/** Called whenever the inputs change: keep counters fresh, then react. */
function handleInputChanged() {
  updateCounts();
  if (els.autoCompare.checked) debouncedCompare();
  else if (state.result) setStale(true);
}

/** Called when settings change: re-run immediately if there is something to update. */
function handleOptionChanged() {
  if (els.autoCompare.checked || state.result) compare();
}

/* ---------------------------------- actions -------------------------------- */

function setTexts(original, modified) {
  els.original.value = original;
  els.modified.value = modified;
  updateCounts();
}

function clearOne(textarea) {
  textarea.value = '';
  textarea.focus();
  handleInputChanged();
}

function clearAll() {
  debouncedCompare.cancel();
  state.runToken++;
  setTexts('', '');
  showEmptyState();
  els.original.focus();
  announce('Both inputs and the results were cleared.');
}

function swapTexts() {
  setTexts(els.modified.value, els.original.value);
  showToast('Texts swapped');
  if (els.autoCompare.checked || state.result) compare();
}

function loadExample() {
  setTexts(EXAMPLE_ORIGINAL, EXAMPLE_MODIFIED);
  compare();
}

async function copyDiff() {
  if (!state.unifiedText) return;
  try {
    await copyToClipboard(state.unifiedText);
    showToast('Unified diff copied to clipboard');
  } catch {
    showToast('Copying was blocked by the browser. Use Download instead, or copy from the Unified view.', 'error');
  }
}

function downloadReport() {
  if (!state.result) return;
  try {
    const report = buildReport({ unifiedText: state.unifiedText, stats: state.stats, options: state.options });
    downloadTextFile(reportFilename(), report);
    showToast('Report downloaded');
  } catch {
    showToast('The download could not be started in this browser.', 'error');
  }
}

function setView(view) {
  state.view = view;
  renderResult(); // same result, different presentation: no recomputation
}

/* ---------------------------------- wiring --------------------------------- */

function bindEvents() {
  els.original.addEventListener('input', handleInputChanged);
  els.modified.addEventListener('input', handleInputChanged);
  els.clearOriginal.addEventListener('click', () => clearOne(els.original));
  els.clearModified.addEventListener('click', () => clearOne(els.modified));

  els.compare.addEventListener('click', compare);
  els.swap.addEventListener('click', swapTexts);
  els.example.addEventListener('click', loadExample);
  els.clearAll.addEventListener('click', clearAll);

  els.ignoreWhitespace.addEventListener('change', handleOptionChanged);
  els.ignoreCase.addEventListener('change', handleOptionChanged);
  els.autoCompare.addEventListener('change', () => {
    if (els.autoCompare.checked) {
      showToast('Auto compare is on');
      compare();
    } else {
      debouncedCompare.cancel();
    }
  });

  els.viewRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) setView(radio.value);
    });
  });

  els.copy.addEventListener('click', copyDiff);
  els.download.addEventListener('click', downloadReport);

  // Ctrl+Enter (Windows/Linux) or Cmd+Enter (macOS) compares from anywhere.
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.repeat) {
      event.preventDefault();
      compare();
    }
  });
}

function init() {
  initTheme();

  const apple = isApplePlatform();
  els.shortcutHint.textContent = apple ? '⌘↵' : 'Ctrl+↵';
  els.compare.setAttribute('aria-keyshortcuts', apple ? 'Meta+Enter' : 'Control+Enter');
  els.limitsNote.textContent =
    `Limit: ${formatNumber(MAX_LINES_PER_SIDE)} lines per side. ` +
    'Ignore whitespace trims line ends and collapses runs of spaces and tabs; ignore case compares case-insensitively.';

  bindEvents();
  updateCounts();
  showEmptyState();
  document.documentElement.dataset.app = 'ready'; // tells bootstrap.js the module graph loaded
}

init();
