import { useEffect, useRef, useState, type PointerEvent } from 'react';

const key = 'oraculum.layout.v1';
export function useLayout() {
  const [layout, setLayout] = useState(() => {
    const defaults = { navigation: true, inspector: false, navigationWidth: 264, inspectorWidth: 420 };
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      return { navigation: typeof saved.navigation === 'boolean' ? saved.navigation : true,
        inspector: typeof saved.inspector === 'boolean' ? saved.inspector : false,
        navigationWidth: Number.isFinite(saved.navigationWidth) ? Math.min(360, Math.max(220, saved.navigationWidth)) : 264,
        inspectorWidth: Number.isFinite(saved.inspectorWidth) ? Math.min(680, Math.max(320, saved.inspectorWidth)) : 420 };
    } catch { return defaults; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* Preferences are optional. */ } }, [layout]);
  return [layout, setLayout] as const;
}

export function ResizeHandle({ side, value, onChange }: { side: 'navigation' | 'inspector'; value: number; onChange: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const min = side === 'navigation' ? 220 : 320;
  const max = side === 'navigation' ? 360 : 680;
  const update = (width: number) => onChange(Math.min(max, Math.max(min, width)));
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current) update(drag.current.width + (event.clientX - drag.current.x) * (side === 'navigation' ? 1 : -1));
  };
  return <div className={`resize-handle resize-${side}`} role="separator" aria-label={side === 'navigation' ? '调整导航宽度' : '调整检查器宽度'}
    aria-orientation="vertical" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0}
    onPointerDown={event => { event.preventDefault(); drag.current = { x: event.clientX, width: event.currentTarget.parentElement?.getBoundingClientRect().width ?? value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); update(value + (event.key === 'ArrowRight' ? 16 : -16) * (side === 'navigation' ? 1 : -1)); } }}/>
}
