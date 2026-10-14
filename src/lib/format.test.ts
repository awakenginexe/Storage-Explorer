import { describe, expect, it } from 'vitest';
import { formatBytes, percentage, sizeTier } from './format';

describe('storage presentation', () => {
  it('uses binary units and preserves zero and unknown allocation', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(null)).toBe('Unavailable');
  });
  it('does not show NaN or over-capacity percentages', () => {
    expect(percentage(40, 100)).toBe(40);
    expect(percentage(5, 0)).toBe(0);
    expect(percentage(101, 100)).toBe(100);
  });
  it('marks file and folder sizes at the documented binary thresholds', () => {
    expect(sizeTier(0)).toBe('normal');
    expect(sizeTier(1024 ** 3 - 1)).toBe('normal');
    expect(sizeTier(1024 ** 3)).toBe('large');
    expect(sizeTier(10 * 1024 ** 3 - 1)).toBe('large');
    expect(sizeTier(10 * 1024 ** 3)).toBe('huge');
  });
});
