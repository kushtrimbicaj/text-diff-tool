import { describe, it, expect } from 'vitest';
import {
  buildReport,
  countText,
  debounce,
  formatNumber,
  isApplePlatform,
  reportFilename,
} from '../src/js/utils.js';
import { diffLines, formatUnified } from '../src/js/diff.js';
import { computeStats } from '../src/js/stats.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('countText', () => {
  it('counts lines the same way the diff splits them', () => {
    expect(countText('')).toEqual({ characters: 0, lines: 0 });
    expect(countText('a\nb')).toEqual({ characters: 3, lines: 2 });
    expect(countText('a\nb\n')).toEqual({ characters: 4, lines: 2 });
    expect(countText('a\r\nb')).toEqual({ characters: 4, lines: 2 });
  });
});

describe('formatNumber', () => {
  it('uses a fixed, locale-independent thousands separator', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0)).toBe('0');
  });
});

describe('isApplePlatform', () => {
  it('detects Mac-like platforms and tolerates a missing navigator', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false);
    expect(isApplePlatform(null)).toBe(false);
  });
});

describe('debounce', () => {
  it('runs once after the quiet period, with the latest arguments', async () => {
    const calls = [];
    const debounced = debounce((value) => calls.push(value), 30);
    debounced(1);
    debounced(2);
    debounced(3);
    expect(calls).toEqual([]);
    await sleep(90);
    expect(calls).toEqual([3]);
  });

  it('can be cancelled', async () => {
    const calls = [];
    const debounced = debounce(() => calls.push('ran'), 20);
    debounced();
    debounced.cancel();
    await sleep(70);
    expect(calls).toEqual([]);
  });
});

describe('reportFilename', () => {
  it('builds a timestamped .txt file name from local time', () => {
    expect(reportFilename(new Date(2026, 9, 26, 23, 5))).toBe('text-diff-report-2026-10-26-2305.txt');
    expect(reportFilename(new Date(2026, 0, 2, 3, 4))).toBe('text-diff-report-2026-01-02-0304.txt');
  });
});

describe('buildReport', () => {
  it('contains options, statistics and the plain-text unified diff (no HTML)', () => {
    const result = diffLines('a\n<b>old</b>\nc', 'a\n<b>new</b>\nc', { ignoreCase: true });
    const unifiedText = formatUnified(result);
    const report = buildReport({
      unifiedText,
      stats: computeStats(result),
      options: result.options,
      generatedAt: new Date('2026-10-26T22:00:00Z'),
    });
    expect(report).toContain('Generated:         2026-10-26T22:00:00.000Z');
    expect(report).toContain('Ignore case:       on');
    expect(report).toContain('Ignore whitespace: off');
    expect(report).toContain('Added lines:       1');
    expect(report).toContain('Removed lines:     1');
    expect(report).toContain('Unchanged lines:   2');
    expect(report).toContain('Line similarity:   66.7%');
    expect(report).toContain('-<b>old</b>');
    expect(report).toContain('+<b>new</b>');
    expect(report).toContain(unifiedText);
  });

  it('states clearly when there are no differences', () => {
    const result = diffLines('same', 'same');
    const report = buildReport({ unifiedText: '', stats: computeStats(result), options: result.options });
    expect(report).toContain('No differences found.');
    expect(report).toContain('Line similarity:   100%');
  });
});
