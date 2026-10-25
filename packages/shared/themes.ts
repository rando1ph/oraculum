// Theme API v1 is visual only. Native protocol/state never travels in a theme.
export const THEME_API = 1;
export const DEFAULT_THEME = 'oracle-eye';
export const themeId = /^[a-z][a-z0-9-]{0,47}$/;
export interface ThemeManifest { id: string; name: string; version: string; themeApi: 1 }
export interface ThemeEntry {
  directory: string;
  builtin?: boolean;
  manifest?: ThemeManifest;
  error?: string;
}
// Keep the v1 selection list compatible: built-ins are available alongside installed packages.
export interface ThemeCatalog { installed: ThemeEntry[]; sources: ThemeEntry[] }
export interface ThemeBundle { manifest: ThemeManifest; css: string; revision: string; assets: string[] }
export const defaultTheme: ThemeManifest = { id: DEFAULT_THEME, name: 'Oracle Eye · 默认', version: '1.0.0', themeApi: 1 };

export const themeColors = {
  '--background': '#000000', '--surface': '#040b10', '--surface-raised': '#08141d', '--surface-hover': '#0b2130',
  '--foreground': '#e5f0f8', '--muted': '#8ba4b7', '--subtle': '#59758a', '--line': '#193645', '--line-bright': '#285971',
  '--accent': '#62d8ff', '--accent-strong': '#00baff', '--accent-soft': '#092c41',
  '--success': '#4bd493', '--warning': '#edba60', '--danger': '#ff8190',
} as const;
export const themeSlots = ['navigation', 'conversation', 'header', 'inspector', 'user-message', 'tool', 'content', 'decoration', 'composer', 'approval', 'settings'] as const;
export const themeMobileMedia = '(max-width: 760px), (pointer: coarse)';
