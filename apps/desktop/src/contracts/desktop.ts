/** The entire renderer capability surface for P4.1. No transport or file access. */
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

export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  setPreferences(patch: Partial<Preferences>): Promise<DesktopState>;
  resetAppearance(): Promise<DesktopState>;
  onStateChanged(listener: (state: DesktopState) => void): () => void;
}
