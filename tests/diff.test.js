import { describe, it, expect } from 'vitest';
import {
  diffLines,
  splitLines,
  normalizeLine,
  buildHunks,
  buildUnifiedLines,
  formatUnified,
  DiffLimitError,
} from '../src/js/diff.js';
import { computeStats, calculateSimilarity } from '../src/js/stats.js';

/* ------------------------------ helpers ---------------------------------- */

const types = (result) => result.ops.map((op) => op.type);
const summary = (result) =>
  result.ops.map((op) => {
    const symbol = { equal: ' ', delete: '-', insert: '+' }[op.type];
    return symbol + (op.type === 'delete' ? op.oldText : op.newText);
  });

/** Rebuild both texts from the ops: proves nothing is lost or invented. */
const reconstruct = (result) => ({
  original: result.ops.filter((op) => op.type !== 'insert').map((op) => op.oldText),
  modified: result.ops.filter((op) => op.type !== 'delete').map((op) => op.newText),
});

/** Reference LCS length (classic DP) to prove Myers output is minimal. */
function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/* ------------------------------ splitting -------------------------------- */

describe('splitLines', () => {
  it('returns no lines for the empty string', () => {
    expect(splitLines('')).toEqual({ lines: [], endsWithNewline: false });
  });

  it('treats a trailing newline as a terminator, not an extra line', () => {
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], endsWithNewline: true });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], endsWithNewline: false });
  });

  it('keeps a lone newline as one blank line', () => {
    expect(splitLines('\n')).toEqual({ lines: [''], endsWithNewline: true });
  });

  it('normalises CRLF and CR to LF', () => {
    expect(splitLines('a\r\nb\rc').lines).toEqual(['a', 'b', 'c']);
  });
});

/* --------------------------- basic comparisons --------------------------- */

describe('diffLines — basic cases', () => {
  it('1. identical texts are all unchanged', () => {
    const result = diffLines('one\ntwo\nthree', 'one\ntwo\nthree');
    expect(types(result)).toEqual(['equal', 'equal', 'equal']);
    expect(result.hasChanges).toBe(false);
    expect(formatUnified(result)).toBe('');
  });

  it('2. completely different texts are fully replaced', () => {
    const result = diffLines('a\nb\nc', 'x\ny');
    expect(summary(result)).toEqual(['-a', '-b', '-c', '+x', '+y']);
    expect(result.hasChanges).toBe(true);
  });

  it('3. one added line', () => {
    const result = diffLines('a\nc', 'a\nb\nc');
    expect(summary(result)).toEqual([' a', '+b', ' c']);
    expect(result.ops[1].newLine).toBe(2);
    expect(result.ops[1].oldLine).toBeNull();
  });

  it('4. one deleted line', () => {
    const result = diffLines('a\nb\nc', 'a\nc');
    expect(summary(result)).toEqual([' a', '-b', ' c']);
    expect(result.ops[1].oldLine).toBe(2);
    expect(result.ops[1].newLine).toBeNull();
  });

  it('5. modified lines are a deletion followed by an insertion', () => {
    const result = diffLines('keep\nold value\nend', 'keep\nnew value\nend');
    expect(summary(result)).toEqual([' keep', '-old value', '+new value', ' end']);
  });

  it('6. empty original text: everything is added', () => {
    const result = diffLines('', 'a\nb');
    expect(summary(result)).toEqual(['+a', '+b']);
    expect(computeStats(result)).toMatchObject({ added: 2, removed: 0, unchanged: 0, originalLines: 0 });
  });

  it('7. empty modified text: everything is removed', () => {
    const result = diffLines('a\nb', '');
    expect(summary(result)).toEqual(['-a', '-b']);
    expect(computeStats(result)).toMatchObject({ added: 0, removed: 2, unchanged: 0, modifiedLines: 0 });
  });

  it('8. both inputs empty: no ops, no changes', () => {
    const result = diffLines('', '');
    expect(result.ops).toEqual([]);
    expect(result.hasChanges).toBe(false);
    expect(computeStats(result).similarity).toBe(100);
  });
});

/* ------------------------- blank and repeated lines ---------------------- */

describe('diffLines — blank and repeated lines', () => {
  it('9. blank lines are real lines', () => {
    const result = diffLines('a\n\nb', 'a\nb');
    expect(summary(result)).toEqual([' a', '-', ' b']);

    const added = diffLines('a\nb', 'a\n\n\nb');
    expect(summary(added)).toEqual([' a', '+', '+', ' b']);
  });

  it('10. repeated lines are classified by position, not by value', () => {
    const result = diffLines('x\nx\nx', 'x\nx');
    expect(types(result).filter((t) => t === 'equal')).toHaveLength(2);
    expect(types(result).filter((t) => t === 'delete')).toHaveLength(1);

    const interleaved = diffLines('a\nb\na\nb\na', 'a\nb\na');
    expect(interleaved.ops.filter((op) => op.type === 'delete')).toHaveLength(2);
    expect(interleaved.ops.filter((op) => op.type === 'insert')).toHaveLength(0);
    expect(reconstruct(interleaved).modified).toEqual(['a', 'b', 'a']);
  });

  it('keeps old/new line numbers correct around repeated lines', () => {
    const result = diffLines('}\n}\n}', '}\n}\nend\n}');
    const inserted = result.ops.find((op) => op.type === 'insert');
    expect(inserted.newText).toBe('end');
    expect(inserted.newLine).toBe(3);
  });
});

/* ------------------------- unicode, endings, newlines -------------------- */

describe('diffLines — unicode and line endings', () => {
  it('11. handles unicode and non-English text without altering it', () => {
    const result = diffLines('héllo\n日本語\nемодзи 😀', 'héllo\n日本語テキスト\nемодзи 😀');
    expect(summary(result)).toEqual([' héllo', '-日本語', '+日本語テキスト', ' емодзи 😀']);
  });

  it('12. Windows and Unix line endings compare as equal', () => {
    const result = diffLines('a\r\nb\r\nc', 'a\nb\nc');
    expect(result.hasChanges).toBe(false);
    expect(result.ops.map((op) => op.oldText)).toEqual(['a', 'b', 'c']); // no stray \r
  });

  it('13a. a trailing newline difference is reported, not silently dropped', () => {
    const result = diffLines('a\nb', 'a\nb\n');
    expect(types(result)).toEqual(['equal', 'equal']);
    expect(result.trailingNewlineChanged).toBe(true);
    expect(result.hasChanges).toBe(true);
    expect(formatUnified(result)).toContain('\\ Original text has no newline at end of file');
  });

  it('13b. an extra trailing blank line is an inserted line', () => {
    const result = diffLines('a\n', 'a\n\n');
    expect(summary(result)).toEqual([' a', '+']);
  });

  it('13c. identical trailing newlines report no change', () => {
    expect(diffLines('a\n', 'a\n').hasChanges).toBe(false);
    expect(diffLines('a', 'a').trailingNewlineChanged).toBe(false);
  });
});

/* ------------------------------ ignore options --------------------------- */

describe('diffLines — ignore options', () => {
  it('14. ignore whitespace trims ends and collapses runs, but keeps original text', () => {
    const original = '  indented   text  \nfoo\tbar';
    const modified = 'indented text\nfoo bar';
    expect(diffLines(original, modified).hasChanges).toBe(true);

    const result = diffLines(original, modified, { ignoreWhitespace: true });
    expect(result.hasChanges).toBe(false);
    expect(result.ops[0].oldText).toBe('  indented   text  ');
    expect(result.ops[0].newText).toBe('indented text');
  });

  it('14b. ignore whitespace does not merge words ("a b" differs from "ab")', () => {
    expect(diffLines('a b', 'ab', { ignoreWhitespace: true }).hasChanges).toBe(true);
  });

  it('14c. ignore whitespace also ignores a trailing-newline-only difference', () => {
    const result = diffLines('a\nb', 'a\nb\n', { ignoreWhitespace: true });
    expect(result.trailingNewlineChanged).toBe(false);
    expect(result.hasChanges).toBe(false);
  });

  it('15. ignore case compares case-insensitively and preserves capitalisation', () => {
    expect(diffLines('Hello World', 'hello world').hasChanges).toBe(true);
    const result = diffLines('Hello World', 'hello world', { ignoreCase: true });
    expect(result.hasChanges).toBe(false);
    expect(result.ops[0].oldText).toBe('Hello World');
    expect(result.ops[0].newText).toBe('hello world');
  });

  it('16. both options combine', () => {
    const result = diffLines('  Hello    WORLD  \nDifferent', 'hello world\nOther', {
      ignoreWhitespace: true,
      ignoreCase: true,
    });
    expect(summary(result)).toEqual([' hello world', '-Different', '+Other']);
  });

  it('normalizeLine applies the enabled options only', () => {
    expect(normalizeLine('  A  B ', {})).toBe('  A  B ');
    expect(normalizeLine('  A  B ', { ignoreWhitespace: true })).toBe('A B');
    expect(normalizeLine('  A  B ', { ignoreCase: true })).toBe('  a  b ');
  });
});

/* ------------------------------ statistics ------------------------------- */

describe('statistics', () => {
  it('17. counts added, removed and unchanged lines correctly', () => {
    const result = diffLines('a\nb\nc\nd', 'a\nc\nd\ne\nf');
    expect(computeStats(result)).toEqual({
      added: 2,
      removed: 1,
      unchanged: 3,
      originalLines: 4,
      modifiedLines: 5,
      similarity: 66.7,
    });
  });

  it('counts always reconcile with the line totals', () => {
    const result = diffLines('1\n2\n3\n4\n5', '2\n3\nx\n5\ny');
    const stats = computeStats(result);
    expect(stats.removed + stats.unchanged).toBe(stats.originalLines);
    expect(stats.added + stats.unchanged).toBe(stats.modifiedLines);
  });

  it('18. similarity = 2 × unchanged ÷ (original + modified)', () => {
    expect(calculateSimilarity(3, 4, 4)).toBe(75);
    expect(calculateSimilarity(0, 3, 2)).toBe(0);
    expect(calculateSimilarity(5, 5, 5)).toBe(100);
    expect(calculateSimilarity(1, 3, 3)).toBe(33.3);
    expect(calculateSimilarity(0, 0, 0)).toBe(100);
    expect(computeStats(diffLines('a\nb\nc\nd', 'a\nb\nc\ne')).similarity).toBe(75);
    expect(computeStats(diffLines('a\nb', 'x\ny')).similarity).toBe(0);
  });
});

/* ------------------------- scale, safety, limits ------------------------- */

describe('diffLines — scale, safety and limits', () => {
  it('19. diffs a large input quickly and minimally', () => {
    const original = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const modified = original.slice();
    modified.splice(100, 1); // delete
    modified.splice(2500, 0, 'inserted A', 'inserted B'); // insert two
    modified[4000] = 'changed'; // modify (1 delete + 1 insert)

    const started = performance.now();
    const result = diffLines(original.join('\n'), modified.join('\n'));
    const elapsed = performance.now() - started;

    const stats = computeStats(result);
    expect(stats.removed).toBe(2);
    expect(stats.added).toBe(3);
    expect(stats.unchanged).toBe(4998);
    expect(result.approximate).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  it('19b. large unrelated inputs finish and stay lossless', () => {
    const original = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const modified = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const result = diffLines(original, modified, { maxEditDistance: 500 });
    expect(result.approximate).toBe(true);
    const rebuilt = reconstruct(result);
    expect(rebuilt.original).toEqual(splitLines(original).lines);
    expect(rebuilt.modified).toEqual(splitLines(modified).lines);
  });

  it('rejects inputs over the line limit with a clear error', () => {
    expect(() => diffLines('a\nb\nc', 'x', { maxLines: 2 })).toThrow(DiffLimitError);
    expect(() => diffLines('x', 'a\nb\nc', { maxLines: 2 })).toThrow(/Modified text has 3 lines/);
  });

  it('20. treats HTML-like content as plain text', () => {
    const payload = '<script>alert("x")</script>';
    const result = diffLines(`<div>\n${payload}\n</div>`, '<div>\n<img src=x onerror=alert(1)>\n</div>');
    expect(summary(result)).toEqual([
      ' <div>',
      `-${payload}`,
      '+<img src=x onerror=alert(1)>',
      ' </div>',
    ]);
    expect(formatUnified(result)).toContain(`-${payload}`);
  });

  it('is lossless and minimal on randomised inputs (checked against a DP LCS)', () => {
    let seed = 12345;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const alphabet = ['a', 'b', 'c', 'd', ''];
    const randomLines = () => Array.from({ length: Math.floor(random() * 25) }, () => alphabet[Math.floor(random() * alphabet.length)]);

    for (let round = 0; round < 200; round++) {
      const a = randomLines();
      const b = randomLines();
      const result = diffLines(a.join('\n'), b.join('\n'));
      const rebuilt = reconstruct(result);
      expect(rebuilt.original).toEqual(splitLines(a.join('\n')).lines);
      expect(rebuilt.modified).toEqual(splitLines(b.join('\n')).lines);
      const equalCount = result.ops.filter((op) => op.type === 'equal').length;
      expect(equalCount).toBe(lcsLength(splitLines(a.join('\n')).lines, splitLines(b.join('\n')).lines));
    }
  });
});

/* ------------------------------ unified output --------------------------- */

describe('unified output', () => {
  const original = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].join('\n');

  it('formats prefixes, file headers and hunk headers', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc');
    expect(formatUnified(result)).toBe(
      ['--- original', '+++ modified', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n')
    );
  });

  it('limits context and splits distant changes into separate hunks', () => {
    const modified = original.replace('\n2\n', '\ntwo\n').replace('\n11\n', '\neleven\n');
    const result = diffLines(original, modified);
    const hunks = buildHunks(result.ops, 1);
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1,3 +1,3 @@', '@@ -10,3 +10,3 @@']);
  });

  it('merges hunks whose context overlaps', () => {
    const modified = original.replace('\n2\n', '\ntwo\n').replace('\n5\n', '\nfive\n');
    const hunks = buildHunks(diffLines(original, modified).ops, 3);
    expect(hunks).toHaveLength(1);
  });

  it('reports an empty old range as the line before the hunk (like git)', () => {
    const lines = buildUnifiedLines(diffLines('', 'a\nb'));
    expect(lines.find((l) => l.kind === 'hunk').text).toBe('@@ -0,0 +1,2 @@');
  });

  it('exposes the same prefixes and numbers the on-screen view uses', () => {
    const lines = buildUnifiedLines(diffLines('a\nb', 'a\nc'));
    const body = lines.filter((l) => ['context', 'delete', 'insert'].includes(l.kind));
    expect(body.map((l) => [l.prefix, l.content, l.oldLine, l.newLine])).toEqual([
      [' ', 'a', 1, 1],
      ['-', 'b', 2, null],
      ['+', 'c', null, 2],
    ]);
  });
});
