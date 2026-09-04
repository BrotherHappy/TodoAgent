export interface ScreenRegion { x: number; y: number; width: number; height: number }
export interface AgentContextPreview {
  token: string;
  kind: 'file' | 'image';
  title: string;
  preview: string;
  characters?: number;
  imageDataUrl?: string;
  expiresAt: string;
}
export type AgentContextMaterial = { kind: 'file'; title: string; text: string } | { kind: 'image'; title: string; imageDataUrl: string };
export interface AgentContextApi {
  chooseFile(): Promise<AgentContextPreview | null>;
  selectScreenRegion(): Promise<AgentContextPreview | null>;
  finishScreenRegion(region: ScreenRegion | null): Promise<void>;
  discard(token: string): Promise<void>;
}
export const AGENT_CONTEXT_CHANNELS = {
  chooseFile: 'agent-context:file', selectScreen: 'agent-context:screen',
  finishScreen: 'agent-context:screen-finish', discard: 'agent-context:discard',
} as const;
