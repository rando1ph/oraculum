import { useEffect, useState } from 'react';

declare global {
  interface Window { oraculumAndroidBack?: () => boolean }
}

export const androidShell = /OraculumAndroid\/1/.test(navigator.userAgent);
export const mobileQuery = '(max-width: 760px), (pointer: coarse)';

export function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(mobileQuery).matches);
  useEffect(() => {
    const query = matchMedia(mobileQuery);
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const update = () => document.documentElement.style.setProperty('--app-height', `${visualViewport?.height ?? innerHeight}px`);
    update();
    visualViewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    return () => {
      visualViewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--app-height');
    };
  }, [mobile]);
  return mobile;
}
