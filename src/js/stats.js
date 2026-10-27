/**
 * stats.js — comparison statistics derived from a diff result.
 *
 * Definitions (all counts are in lines):
 *   added          insert ops: lines present only in the modified text
 *   removed        delete ops: lines present only in the original text
 *   unchanged      equal ops: lines matched between both texts (after the
 *                  ignore-whitespace / ignore-case rules, if enabled)
 *   originalLines  total lines in the original text
 *   modifiedLines  total lines in the modified text
 *   similarity     see calculateSimilarity()
 */

/**
 * Line similarity as a percentage:
 *
 *     similarity = 2 × unchanged ÷ (originalLines + modifiedLines) × 100
 *
 * This is a project-specific, line-level metric (the same shape as the Dice
 * coefficient), not an industry-standard score. Identical texts give 100 and
 * texts sharing no lines give 0. Two empty texts are defined as 100.
 * The result is rounded to one decimal place.
 */
export function calculateSimilarity(unchanged, originalLines, modifiedLines) {
  const total = originalLines + modifiedLines;
  if (total === 0) return 100;
  return Math.round(((2 * unchanged) / total) * 1000) / 10;
}

/** @param {{ ops: object[], original: {lineCount:number}, modified: {lineCount:number} }} result */
export function computeStats(result) {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of result.ops) {
    if (op.type === 'insert') added++;
    else if (op.type === 'delete') removed++;
    else unchanged++;
  }
  const originalLines = result.original.lineCount;
  const modifiedLines = result.modified.lineCount;
  return {
    added,
    removed,
    unchanged,
    originalLines,
    modifiedLines,
    similarity: calculateSimilarity(unchanged, originalLines, modifiedLines),
  };
}
