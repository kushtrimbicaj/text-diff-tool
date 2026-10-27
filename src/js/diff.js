/**
 * diff.js — pure, DOM-free line diff engine.
 *
 * Pipeline
 *   1. splitLines()      Normalise line endings, remember trailing-newline state.
 *   2. toComparableIds() Build a comparison key per line (honouring the ignore
 *                        options) and intern keys as small integers so the inner
 *                        loop only compares numbers.
 *   3. computeEdits()    Trim the common prefix/suffix, then run Myers' O(ND)
 *                        shortest-edit-script algorithm on what is left.
 *   4. groupChangeBlocks() Reorder each change block as "all deletions, then all
 *                        insertions" so every view can pair them consistently.
 *
 * The original line text is never modified: ops always carry the untouched
 * source lines, only the *comparison keys* are normalised.
 */

/** Hard input limit per side. Larger inputs are rejected with a DiffLimitError. */
export const MAX_LINES_PER_SIDE = 20000;

/**
 * Cap on the Myers edit distance D (number of inserted + deleted lines in the
 * changed region). Memory grows with O(D^2), so D is bounded. When it is
 * exceeded we fall back to a coarse (valid but non-minimal) diff and flag it.
 */
export const MAX_EDIT_DISTANCE = 2000;

/** Lines of unchanged context shown around each change in unified output. */
export const DEFAULT_CONTEXT_LINES = 3;

export class DiffLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiffLimitError';
    this.code = 'LINE_LIMIT_EXCEEDED';
  }
}

/* -------------------------------------------------------------------------- */
/* Step 1 — splitting                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Split text into lines. "\r\n" and lone "\r" are treated as "\n".
 * A single trailing newline terminates the last line; it does not create an
 * extra empty line. "" has zero lines, "\n" has one empty line.
 *
 * @param {string} text
 * @returns {{ lines: string[], endsWithNewline: boolean }}
 */
export function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: false };
  const normalized = text.replace(/\r\n?/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const body = endsWithNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body.split('\n'), endsWithNewline };
}

/* -------------------------------------------------------------------------- */
/* Step 2 — comparison keys                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Comparison key for one line.
 *  - ignoreWhitespace: trim both ends and collapse every internal run of
 *    whitespace to a single space ("a   b" == " a b "), but "a b" != "ab".
 *  - ignoreCase: lower-case the key.
 */
export function normalizeLine(line, { ignoreWhitespace = false, ignoreCase = false } = {}) {
  let key = line;
  if (ignoreWhitespace) key = key.replace(/\s+/g, ' ').trim();
  if (ignoreCase) key = key.toLowerCase();
  return key;
}

/** Map every distinct key to an integer id shared by both sides. */
function toComparableIds(originalLines, modifiedLines, options) {
  const ids = new Map();
  const toIds = (lines) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const key = normalizeLine(lines[i], options);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [toIds(originalLines), toIds(modifiedLines)];
}

/* -------------------------------------------------------------------------- */
/* Step 3 — edit script (Myers)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Edit = { type: 'equal' | 'delete' | 'insert', i, j }
 *   i = index in the original (or -1 for inserts)
 *   j = index in the modified (or -1 for deletes)
 */
const edit = (type, i, j) => ({ type, i, j });

/**
 * Myers' greedy O(ND) algorithm (E. Myers, "An O(ND) Difference Algorithm and
 * Its Variations", 1986). It finds a *shortest* edit script, i.e. the minimum
 * number of inserted + deleted lines, which is equivalent to a longest common
 * subsequence. Repeated lines are handled correctly because the algorithm
 * works on positions, never on "has this line been seen before".
 *
 * Idea: view the problem as a path from (0,0) to (n,m) on an edit graph where
 * a right step deletes a[x], a down step inserts b[y], and a diagonal step is
 * free when a[x] == b[y]. V[k] holds the furthest x reached on diagonal
 * k = x - y after d edits. We snapshot V after every d so the path can be
 * recovered by walking backwards.
 *
 * Time O((N+M)·D), memory O(D²) for the snapshots (hence maxD).
 *
 * @returns {Array|null} edits in order, or null when D exceeds maxD
 */
function myersEdits(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1; // V index = k + offset
  const v = new Int32Array(2 * limit + 3);
  const trace = []; // trace[d][k + d] = furthest x on diagonal k after d edits

  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      // Choose the better of "come from above (insert)" or "from the left (delete)".
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      // Follow the free diagonal while lines match.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;

      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, a, b);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

/** Walk the saved V snapshots from (n,m) back to (0,0) to rebuild the script. */
function backtrack(trace, a, b) {
  const edits = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    if (d === 0) {
      // With zero edits the path is a pure diagonal from (0,0).
      while (x > 0 && y > 0) {
        x--;
        y--;
        edits.push(edit('equal', x, y));
      }
      break;
    }
    const prev = trace[d - 1]; // indexed by (k + d - 1)
    const k = x - y;
    const cameFromAbove = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = cameFromAbove ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push(edit('equal', x, y));
    }
    if (cameFromAbove) {
      y--;
      edits.push(edit('insert', -1, y));
    } else {
      x--;
      edits.push(edit('delete', x, -1));
    }
  }
  return edits.reverse();
}

/** Diff the region left after prefix/suffix trimming (indices are relative). */
function diffMiddle(a, b, maxD) {
  const edits = [];
  if (a.length === 0 || b.length === 0) {
    // One side empty: nothing to align, no need for Myers (and no D limit).
    for (let i = 0; i < a.length; i++) edits.push(edit('delete', i, -1));
    for (let j = 0; j < b.length; j++) edits.push(edit('insert', -1, j));
    return { edits, approximate: false };
  }
  const found = myersEdits(a, b, maxD);
  if (found) return { edits: found, approximate: false };

  // Too different to align within the memory budget: report the region as
  // fully replaced. This is a valid diff, just not a minimal one.
  for (let i = 0; i < a.length; i++) edits.push(edit('delete', i, -1));
  for (let j = 0; j < b.length; j++) edits.push(edit('insert', -1, j));
  return { edits, approximate: true };
}

/**
 * Full edit script: common prefix + diffMiddle + common suffix.
 * Trimming first is a cheap, large win for typical "small edit in a big file".
 */
function computeEdits(a, b, maxD) {
  const n = a.length;
  const m = b.length;

  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const edits = [];
  for (let i = 0; i < start; i++) edits.push(edit('equal', i, i));

  const middle = diffMiddle(a.subarray(start, endA), b.subarray(start, endB), maxD);
  for (const e of middle.edits) {
    edits.push(edit(e.type, e.i === -1 ? -1 : e.i + start, e.j === -1 ? -1 : e.j + start));
  }

  for (let t = 0; t < n - endA; t++) edits.push(edit('equal', endA + t, endB + t));
  return { edits, approximate: middle.approximate };
}

/* -------------------------------------------------------------------------- */
/* Step 4 — ops                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Op = {
 *   type: 'equal' | 'delete' | 'insert',
 *   oldLine, newLine,   // 1-based line numbers, null when the side is absent
 *   oldText, newText    // untouched source lines, null when the side is absent
 * }
 * For 'equal' both texts are kept because they may differ by ignored
 * whitespace/case.
 */
function toOp(e, originalLines, modifiedLines) {
  return {
    type: e.type,
    oldLine: e.i === -1 ? null : e.i + 1,
    newLine: e.j === -1 ? null : e.j + 1,
    oldText: e.i === -1 ? null : originalLines[e.i],
    newText: e.j === -1 ? null : modifiedLines[e.j],
  };
}

/** Within each run of changes, put deletions before insertions (stable). */
function groupChangeBlocks(ops) {
  const out = [];
  let deletions = [];
  let insertions = [];
  const flush = () => {
    for (const op of deletions) out.push(op);
    for (const op of insertions) out.push(op);
    deletions = [];
    insertions = [];
  };
  for (const op of ops) {
    if (op.type === 'equal') {
      flush();
      out.push(op);
    } else if (op.type === 'delete') {
      deletions.push(op);
    } else {
      insertions.push(op);
    }
  }
  flush();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compare two texts line by line.
 *
 * @param {string} originalText
 * @param {string} modifiedText
 * @param {object} [options]
 * @param {boolean} [options.ignoreWhitespace=false]
 * @param {boolean} [options.ignoreCase=false]
 * @param {number}  [options.maxLines=MAX_LINES_PER_SIDE]
 * @param {number}  [options.maxEditDistance=MAX_EDIT_DISTANCE]
 * @returns {{
 *   ops: object[],
 *   original: { lineCount: number, endsWithNewline: boolean },
 *   modified: { lineCount: number, endsWithNewline: boolean },
 *   options: { ignoreWhitespace: boolean, ignoreCase: boolean },
 *   trailingNewlineChanged: boolean,
 *   approximate: boolean,
 *   hasChanges: boolean
 * }}
 * @throws {DiffLimitError} when either side exceeds maxLines
 */
export function diffLines(originalText, modifiedText, options = {}) {
  const {
    ignoreWhitespace = false,
    ignoreCase = false,
    maxLines = MAX_LINES_PER_SIDE,
    maxEditDistance = MAX_EDIT_DISTANCE,
  } = options;

  const original = splitLines(originalText);
  const modified = splitLines(modifiedText);

  for (const [label, side] of [['Original', original], ['Modified', modified]]) {
    if (side.lines.length > maxLines) {
      throw new DiffLimitError(
        `${label} text has ${side.lines.length.toLocaleString('en-US')} lines. ` +
          `The limit is ${maxLines.toLocaleString('en-US')} lines per side.`
      );
    }
  }

  const [a, b] = toComparableIds(original.lines, modified.lines, { ignoreWhitespace, ignoreCase });
  const { edits, approximate } = computeEdits(a, b, maxEditDistance);
  const ops = groupChangeBlocks(edits.map((e) => toOp(e, original.lines, modified.lines)));

  // A trailing-newline difference is only meaningful when whitespace counts
  // and both sides actually have lines to terminate.
  const trailingNewlineChanged =
    !ignoreWhitespace &&
    original.lines.length > 0 &&
    modified.lines.length > 0 &&
    original.endsWithNewline !== modified.endsWithNewline;

  return {
    ops,
    original: { lineCount: original.lines.length, endsWithNewline: original.endsWithNewline },
    modified: { lineCount: modified.lines.length, endsWithNewline: modified.endsWithNewline },
    options: { ignoreWhitespace, ignoreCase },
    trailingNewlineChanged,
    approximate,
    hasChanges: trailingNewlineChanged || ops.some((op) => op.type !== 'equal'),
  };
}

/* -------------------------------------------------------------------------- */
/* Unified output (single source for the unified view, copy and download)    */
/* -------------------------------------------------------------------------- */

/**
 * Group ops into hunks: every change plus `context` unchanged lines either
 * side; hunks whose context overlaps are merged.
 *
 * @returns {{ header: string, ops: object[] }[]}
 */
export function buildHunks(ops, context = DEFAULT_CONTEXT_LINES) {
  const ranges = [];
  ops.forEach((op, index) => {
    if (op.type === 'equal') return;
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });

  // Running totals so each hunk header can state where it starts.
  const oldBefore = [0];
  const newBefore = [0];
  for (const op of ops) {
    oldBefore.push(oldBefore[oldBefore.length - 1] + (op.oldLine === null ? 0 : 1));
    newBefore.push(newBefore[newBefore.length - 1] + (op.newLine === null ? 0 : 1));
  }

  return ranges.map(({ start, end }) => {
    const hunkOps = ops.slice(start, end);
    const oldCount = oldBefore[end] - oldBefore[start];
    const newCount = newBefore[end] - newBefore[start];
    // Like git: an empty range is reported as the line *before* the hunk.
    const oldStart = oldCount === 0 ? oldBefore[start] : oldBefore[start] + 1;
    const newStart = newCount === 0 ? newBefore[start] : newBefore[start] + 1;
    return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ops: hunkOps };
  });
}

/**
 * Structured unified diff lines.
 * kind: 'file' | 'hunk' | 'context' | 'delete' | 'insert' | 'note'
 * Every entry has `text` (exactly what appears in the copied/downloaded diff),
 * plus `prefix`/`content` and line numbers for the on-screen view.
 */
export function buildUnifiedLines(result, { context = DEFAULT_CONTEXT_LINES } = {}) {
  const hunks = buildHunks(result.ops, context);
  const lines = [];
  const meta = (kind, text) => ({ kind, text, prefix: '', content: text, oldLine: null, newLine: null });

  if (hunks.length > 0 || result.trailingNewlineChanged) {
    lines.push(meta('file', '--- original'), meta('file', '+++ modified'));
  }

  const PREFIX = { equal: ' ', delete: '-', insert: '+' };
  const KIND = { equal: 'context', delete: 'delete', insert: 'insert' };

  for (const hunk of hunks) {
    lines.push(meta('hunk', hunk.header));
    for (const op of hunk.ops) {
      const prefix = PREFIX[op.type];
      const content = op.type === 'delete' ? op.oldText : op.newText;
      lines.push({
        kind: KIND[op.type],
        prefix,
        content,
        text: prefix + content,
        oldLine: op.oldLine,
        newLine: op.newLine,
      });
    }
  }

  if (result.trailingNewlineChanged) {
    const side = result.original.endsWithNewline ? 'Modified' : 'Original';
    lines.push(meta('note', `\\ ${side} text has no newline at end of file`));
  }
  return lines;
}

/** The unified diff as plain text ('' when there are no differences). */
export function formatUnified(result, options) {
  const lines = buildUnifiedLines(result, options);
  return lines.length === 0 ? '' : lines.map((line) => line.text).join('\n') + '\n';
}
