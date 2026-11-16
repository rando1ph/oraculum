import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  folder: <path d="M3 7V5h7l2 3h9v12H3z" />,
  chat: <path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  file: <path d="M5 2h9l5 5v15H5zM14 2v6h5M9 12h6M9 16h6" />,
  shield: <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6" />,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
  refresh: <path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" />,
  offline: <path d="m3 3 18 18M2 8a17 17 0 0 1 3-2m4-1a17 17 0 0 1 13 3M5 12a12 12 0 0 1 4-2m6 0a12 12 0 0 1 4 2M8 16a7 7 0 0 1 4-1m0 5h.01" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 2 3-1 2 4 4-1 1-3 4-1v-4l-3-1-1-4-4-1-1-3z" /><circle cx="12" cy="12" r="3" /></>,
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export function BrandIcon({ size = 'navigation' }: { size?: 'navigation' | 'avatar' | 'hero' }) {
  return <span className={`oracle-eye oracle-eye-${size}${size === 'hero' ? ' connect-eye' : ''}`} role="img" aria-label="神谕之眼" />;
}
