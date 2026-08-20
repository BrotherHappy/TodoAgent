// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  floatingWindowSize,
  floatingWindowInteractionOptions,
  floatingMousePassthroughOptions,
  snapToWorkArea,
} from '../electron/window-manager';

describe('floatingWindowSize', () => {
  it('uses a true pet-only footprint while preserving existing compact sizes', () => {
    expect(floatingWindowSize(false, 100, true)).toEqual({ width: 148, height: 148 });
    expect(floatingWindowSize(false, 75, true)).toEqual({ width: 112, height: 112 });
    expect(floatingWindowSize(false, 75)).toEqual({ width: 329, height: 184 });
    expect(floatingWindowSize(true, 75)).toEqual({ width: 480, height: 640 });
  });
});

describe('floatingWindowInteractionOptions', () => {
  it('accepts the first click on an inactive macOS Todo Pet', () => {
    expect(floatingWindowInteractionOptions('darwin')).toEqual({
      acceptFirstMouse: true,
    });
  });

  it('does not configure the macOS-only click-through option on other platforms', () => {
    expect(floatingWindowInteractionOptions('win32')).toEqual({});
    expect(floatingWindowInteractionOptions('linux')).toEqual({});
  });
});

describe('floatingMousePassthroughOptions', () => {
  it('keeps the visible pet transparent to clicks only when explicitly enabled', () => {
    expect(floatingMousePassthroughOptions(false)).toEqual({ ignore: false, forward: true });
    expect(floatingMousePassthroughOptions(true)).toEqual({ ignore: true, forward: true });
  });
});

describe('snapToWorkArea', () => {
  const workArea = { x: 0, y: 24, width: 1440, height: 876 };

  it('snaps near edges and keeps the entire window visible', () => {
    expect(snapToWorkArea({ x: 10, y: 30, width: 300, height: 100 }, workArea)).toEqual({ x: 0, y: 24, width: 300, height: 100 });
    expect(snapToWorkArea({ x: 1420, y: 890, width: 300, height: 100 }, workArea)).toEqual({ x: 1140, y: 800, width: 300, height: 100 });
  });

  it('preserves a position that is not near an edge', () => {
    expect(snapToWorkArea({ x: 500, y: 300, width: 300, height: 100 }, workArea)).toEqual({ x: 500, y: 300, width: 300, height: 100 });
  });
});
