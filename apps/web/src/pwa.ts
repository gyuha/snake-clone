/** Register only where a service worker is meaningful; Vite dev remains live-reload friendly. */
export function registerPwa(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    // Offline support must never prevent an online match from starting.
  });
}
