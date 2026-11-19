export const DEFAULT_LAYOUT = { navigationVisible: true, navigationWidth: 256, inspectorWidth: 344 };

export function panelWidths(viewport: number, navigation: number, inspector: number, navigationVisible: boolean, inspectorVisible: boolean, compact: boolean) {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const width = Math.max(0, finite(viewport, 1280));
  const inspectorWidth = Math.max(280, Math.min(560, finite(inspector, 344), compact ? width - 48 : width - (navigationVisible ? 200 : 0) - 440));
  const navigationWidth = Math.max(190, Math.min(360, finite(navigation, 256), width - (!compact && inspectorVisible ? inspectorWidth : 0) - 440));
  return { navigationWidth, inspectorWidth };
}

/** Some input methods finish composition before delivering the confirming key. */
export function composingKey(event: { isComposing?: boolean; keyCode?: number; timeStamp: number }, composing = false, endedAt = -Infinity): boolean {
  return composing || event.isComposing === true || event.keyCode === 229 || event.timeStamp >= endedAt && event.timeStamp - endedAt < 50;
}

export function sendShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number; timeStamp: number }, composing = false, endedAt = -Infinity): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !composingKey(event, composing, endedAt);
}
