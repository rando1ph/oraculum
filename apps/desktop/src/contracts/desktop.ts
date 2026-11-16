import type { WorkspaceBridge } from './workspace';
/** Named business intents only. No transport or filesystem capability. */
export type Theme = 'light' | 'dark' | 'oled';

export interface Preferences {
  theme: Theme;
  inspectorVisible: boolean;
}

export interface DesktopState {
  preferences: Preferences;
  profile: 'development' | 'production';
  preferencesRecovered: boolean;
}

export interface DesktopBridge extends WorkspaceBridge {
  getState(): Promise<DesktopState>;
  setPreferences(patch: Partial<Preferences>): Promise<DesktopState>;
  resetAppearance(): Promise<DesktopState>;
  onStateChanged(listener: (state: DesktopState) => void): () => void;
}
