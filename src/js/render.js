/**
 * render.js — turns diff results into DOM.
 *
 * Security: user text is only ever assigned through `textContent` (see `el`).
 * There is no innerHTML / insertAdjacentHTML / document.write anywhere, so
 * input such as "<script>" is displayed literally and never parsed as markup.
 */
import { buildUnifiedLines } from './diff.js';
import { formatNumber } from './utils.js';

/** Create an element; `text` is set via textContent so it can never become markup. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function scrollRegion(label) {
  const region = el('div', 'diff-scroll');
  region.tabIndex = 0; // lets keyboard users scroll long lines
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', label);
  return region;
}

/* ------------------------------ messages --------------------------------- */

/**
 * Show a message in place of a diff (empty input, no differences, errors).
 * @param {HTMLElement} container
 * @param {{ title: string, body?: string, tone?: 'info'|'success'|'error' }} message
 */
export function renderMessage(container, { title, body = '', tone = 'info' }) {
  const box = el('div', `empty-state empty-${tone}`);
  if (tone === 'error') box.setAttribute('role', 'alert');
  box.append(el('p', 'empty-title', title));
  if (body) box.append(el('p', 'empty-body', body));
  container.replaceChildren(box);
}

/** A small inline notice shown above a diff (e.g. the "coarse diff" warning). */
export function createNotice(text, tone = 'warn') {
  return el('p', `notice notice-${tone}`, text);
}

/* ------------------------------ statistics ------------------------------- */

/** Fill the stat tiles; pass null to reset them to placeholders. */
export function renderStats(root, stats) {
  root.querySelectorAll('[data-stat]').forEach((node) => {
    const key = node.dataset.stat;
    if (!stats) node.textContent = '–';
    else if (key === 'similarity') node.textContent = `${stats.similarity}%`;
    else node.textContent = formatNumber(stats[key]);
  });
}

/* ----------------------------- side-by-side ------------------------------ */

/**
 * Pair ops into table rows. Within a change block deletions come first, then
 * insertions (guaranteed by diff.js), so the n-th deletion is shown next to
 * the n-th insertion and the remainder sits opposite an empty cell.
 */
function pairRows(ops) {
  const rows = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index];
    if (op.type === 'equal') {
      rows.push({ left: op, right: op });
      index++;
      continue;
    }
    const deletions = [];
    const insertions = [];
    while (index < ops.length && ops[index].type === 'delete') deletions.push(ops[index++]);
    while (index < ops.length && ops[index].type === 'insert') insertions.push(ops[index++]);
    const height = Math.max(deletions.length, insertions.length);
    for (let n = 0; n < height; n++) {
      rows.push({ left: deletions[n] || null, right: insertions[n] || null });
    }
  }
  return rows;
}

const MARKERS = {
  equal: { symbol: ' ', label: '', className: 'cell-equal' },
  delete: { symbol: '−', label: 'Removed', className: 'cell-delete' },
  insert: { symbol: '+', label: 'Added', className: 'cell-insert' },
};

function appendCell(row, op, side) {
  const number = el('td', 'cell-num', '');
  const code = el('td', 'cell-code');
  if (!op) {
    number.classList.add('cell-blank');
    code.classList.add('cell-blank');
    row.append(number, code);
    return;
  }
  const marker = MARKERS[op.type];
  const line = side === 'left' ? op.oldLine : op.newLine;
  const text = side === 'left' ? op.oldText : op.newText;
  number.textContent = String(line);
  number.classList.add(marker.className);
  code.classList.add(marker.className);

  const sign = el('span', 'marker', marker.symbol);
  if (marker.label) sign.setAttribute('aria-label', marker.label);
  else sign.setAttribute('aria-hidden', 'true');
  code.append(sign, el('span', 'code-text', text));
  row.append(number, code);
}

/** Unchanged runs longer than this are folded (keeps huge, mostly-equal files fast). */
const FOLD_MIN_LINES = 12;
/** Unchanged lines kept visible next to a change when a run is folded. */
const FOLD_CONTEXT_LINES = 3;

const isUnchangedRow = (row) => row.left !== null && row.left === row.right;

/**
 * Split rows into visible rows and folded runs of unchanged lines.
 * Short inputs are never folded, so small comparisons show every line.
 */
function foldRows(rows) {
  const items = [];
  let index = 0;
  while (index < rows.length) {
    if (!isUnchangedRow(rows[index])) {
      items.push({ row: rows[index++] });
      continue;
    }
    const start = index;
    while (index < rows.length && isUnchangedRow(rows[index])) index++;
    const run = rows.slice(start, index);
    const keepHead = start === 0 ? 0 : FOLD_CONTEXT_LINES;
    const keepTail = index === rows.length ? 0 : FOLD_CONTEXT_LINES;
    if (run.length <= FOLD_MIN_LINES) {
      run.forEach((row) => items.push({ row }));
      continue;
    }
    run.slice(0, keepHead).forEach((row) => items.push({ row }));
    items.push({ fold: run.slice(keepHead, run.length - keepTail) });
    run.slice(run.length - keepTail).forEach((row) => items.push({ row }));
  }
  return items;
}

function createDiffRow({ left, right }) {
  const row = el('tr');
  appendCell(row, left, 'left');
  appendCell(row, right, 'right');
  return row;
}

/** A row with a button that swaps itself for the hidden unchanged lines. */
function createFoldRow(hiddenRows) {
  const row = el('tr', 'fold-row');
  const cell = el('td');
  cell.colSpan = 4;
  const button = el('button', 'btn btn-small btn-ghost fold-btn', `⋯ Show ${formatNumber(hiddenRows.length)} unchanged lines`);
  button.type = 'button';
  button.addEventListener('click', () => {
    const fragment = document.createDocumentFragment();
    hiddenRows.forEach((hidden) => fragment.append(createDiffRow(hidden)));
    const first = fragment.firstElementChild;
    row.replaceWith(fragment);
    first.tabIndex = -1; // keep keyboard focus where the button was
    first.focus();
  });
  cell.append(button);
  row.append(cell);
  return row;
}

export function renderSideBySide(container, result) {
  const region = scrollRegion('Side-by-side comparison. Original on the left, modified on the right.');
  const table = el('table', 'diff-table');
  table.append(el('caption', 'sr-only', 'Original text compared with modified text, line by line'));

  const head = el('thead');
  const headRow = el('tr');
  for (const title of ['Original', 'Modified']) {
    const cell = el('th', 'diff-heading', title);
    cell.colSpan = 2;
    cell.scope = 'colgroup';
    headRow.append(cell);
  }
  head.append(headRow);

  const body = el('tbody');
  const fragment = document.createDocumentFragment();
  for (const item of foldRows(pairRows(result.ops))) {
    fragment.append(item.fold ? createFoldRow(item.fold) : createDiffRow(item.row));
  }
  body.append(fragment);

  table.append(head, body);
  region.append(table);
  container.replaceChildren(region);
}

/* -------------------------------- unified -------------------------------- */

export function renderUnified(container, result) {
  const region = scrollRegion('Unified diff');
  const table = el('table', 'diff-table unified-table');
  table.append(el('caption', 'sr-only', 'Unified diff. Removed lines start with minus, added lines with plus.'));

  const body = el('tbody');
  const fragment = document.createDocumentFragment();
  for (const line of buildUnifiedLines(result)) {
    const row = el('tr', `u-row u-${line.kind}`);
    if (line.kind === 'file' || line.kind === 'hunk' || line.kind === 'note') {
      const cell = el('td', 'u-meta', line.text);
      cell.colSpan = 3;
      row.append(cell);
    } else {
      const description = { delete: 'Removed', insert: 'Added', context: '' }[line.kind];
      const text = el('td', 'cell-code u-text');
      const sign = el('span', 'marker', line.prefix === ' ' ? ' ' : line.prefix);
      if (description) sign.setAttribute('aria-label', description);
      else sign.setAttribute('aria-hidden', 'true');
      text.append(sign, el('span', 'code-text', line.content));
      row.append(el('td', 'cell-num', line.oldLine === null ? '' : String(line.oldLine)));
      row.append(el('td', 'cell-num', line.newLine === null ? '' : String(line.newLine)));
      row.append(text);
    }
    fragment.append(row);
  }
  body.append(fragment);
  table.append(body);
  region.append(table);
  container.replaceChildren(region);
}
