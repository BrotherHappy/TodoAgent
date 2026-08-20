import { describe, expect, it } from 'vitest';
import {
  focusShieldModeLabel,
  matchesShieldApplication,
  normalizeShieldApplications,
} from '../src/renderer/focus-shield';

describe('focus shield helpers', () => {
  it('trims, deduplicates, bounds, and preserves display casing', () => {
    expect(normalizeShieldApplications([' Chrome ', 'chrome', '', 3, 'YouTube'])).toEqual([
      'Chrome',
      'YouTube',
    ]);
    expect(normalizeShieldApplications(Array.from({ length: 20 }, (_, index) => `App ${index}`))).toHaveLength(12);
  });

  it('matches app names case-insensitively without using window titles', () => {
    expect(matchesShieldApplication('Google Chrome', ['youtube', 'chrome'])).toBe('chrome');
    expect(matchesShieldApplication('Visual Studio Code', ['slack'])).toBeUndefined();
    expect(matchesShieldApplication('   ', ['chrome'])).toBeUndefined();
  });

  it('labels the three safe modes', () => {
    expect(focusShieldModeLabel('off')).toBe('关闭');
    expect(focusShieldModeLabel('gentle')).toBe('温和提醒');
    expect(focusShieldModeLabel('pause')).toBe('匹配时自动暂停');
  });
});

