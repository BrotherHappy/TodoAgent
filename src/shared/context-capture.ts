/**
 * Clipboard text is user-controlled context, not an instruction to execute.
 * Keep the preview bounded before it reaches the renderer or a model prompt.
 */
export const CLIPBOARD_CONTEXT_MAX_CHARS = 12_000;

export interface ClipboardContextPreview {
  text: string;
  characters: number;
  truncated: boolean;
  capturedAt: string;
}

export interface SelectedTextContextPreview extends ClipboardContextPreview {
  source: "selected-text";
}

export const buildClipboardContextPreview = (
  raw: string,
  capturedAt = new Date(),
): ClipboardContextPreview => {
  const text = raw.slice(0, CLIPBOARD_CONTEXT_MAX_CHARS);
  return {
    text,
    characters: raw.length,
    truncated: raw.length > text.length,
    capturedAt: capturedAt.toISOString(),
  };
};

export const buildSelectedTextContextPreview = (
  raw: string,
  capturedAt = new Date(),
): SelectedTextContextPreview => ({
  ...buildClipboardContextPreview(raw, capturedAt),
  source: "selected-text",
});
