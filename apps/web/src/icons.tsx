export type IconName = 'plus' | 'close' | 'panel' | 'search' | 'folder' | 'file' | 'settings' | 'send' | 'stop' | 'refresh' | 'chevron' | 'terminal' | 'arrowDown' | 'arrowUp' | 'expand' | 'more' | 'back' | 'archive' | 'restore' | 'trash' | 'shield' | 'model' | 'check';
const paths: Record<IconName, string> = {
  shield: 'M12 3 4 6v6c0 4 5 7 8 9 3-2 8-5 8-9V6ZM9 12l2 2 4-4',
  model: 'M2 12c4-1.5 8-3.5 10-7 2 3.5 6 5.5 10 7-4 1.5-8 3.5-10 7-2-3.5-6-5.5-10-7ZM12 9c0 2-1 3-3 3 2 0 3 1 3 3 0-2 1-3 3-3-2 0-3-1-3-3Z',
  check: 'm5 12 4 4L19 6', arrowUp: 'M12 21V3m-7 7 7-7 7 7',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M10 12h4',
  restore: 'M4 10a8 8 0 1 1 0 5M4 4v6h6M12 8v5l3 2',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  more: 'M12 4h.01M12 12h.01M12 20h.01', back: 'M20 12H4m7-7-7 7 7 7',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6',
  panel: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM9 3v18',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  folder: 'M3 5h6l2 3h10v12H3Z', file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  send: 'm3 3 18 9-18 9 4-9-4-9ZM7 12h14', stop: 'M6 6h12v12H6Z',
  refresh: 'M20 7a9 9 0 1 0 1 9M20 2v6h-6', chevron: 'm8 4 8 8-8 8',
  terminal: 'm4 6 6 6-6 6M13 18h7', arrowDown: 'M12 3v18m-7-7 7 7 7-7',
  expand: 'M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7',
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}
