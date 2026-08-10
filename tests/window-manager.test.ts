// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  floatingWindowInteractionOptions,
  snapToWorkArea,
} from '../electron/window-manager';

describe('floatingWindowInteractionOptions', () => {
  it('accepts the first click on an inactive macOS floating capsule', () => {
    expect(floatingWindowInteractionOptions('darwin')).toEqual({
      acceptFirstMouse: true,
    });
  });

  it('does not configure the macOS-only click-through option on other platforms', () => {
    expect(floatingWindowInteractionOptions('win32')).toEqual({});
    expect(floatingWindowInteractionOptions('linux')).toEqual({});
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
