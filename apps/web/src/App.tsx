import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Landing, Lobby, SettingsModal, type LobbyChoice } from './ui/screens';
import { apiBase, ensureGuestSession, sendTelemetry } from './lib/session';
import { AdminConsole } from './ui/AdminConsole';

type Screen = 'landing' | 'lobby' | 'game';
const GameView = lazy(async () => ({ default: (await import('./ui/GameView')).GameView }));

/**
 * 제품 셸 (PRD §7.1): 랜딩 → 로비 → 게임 → (결과) → 재도전/로비.
 * `?mode=offline` 은 M1 오프라인 아레나를 직접 띄운다 (개발/데모용).
 */
export function App() {
  if (new URLSearchParams(window.location.search).get('admin') === '1') return <AdminConsole />;
  const offline = new URLSearchParams(window.location.search).get('mode') === 'offline';
  if (offline) return <OfflineArena />;
  return <ProductShell />;
}

function ProductShell() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [choice, setChoice] = useState<LobbyChoice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const base = apiBase();
        const session = await ensureGuestSession(base);
        await sendTelemetry(base, session.accessToken, 'landing_view');
      } catch { /* analytics must not block the shell */ }
    })();
  }, []);

  const play = () => {
    void (async () => {
      try {
        const base = apiBase(); const session = await ensureGuestSession(base);
        await sendTelemetry(base, session.accessToken, 'play_click');
      } catch { /* best effort */ }
    })();
    setScreen('lobby');
  };

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#101418' }}>
      {screen === 'landing' && <Landing onPlay={play} />}
      {screen === 'lobby' && (
        <Lobby
          onEnter={(c) => {
            setChoice(c);
            setScreen('game');
          }}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {screen === 'game' && choice && <Suspense fallback={<div style={{ color: '#d8e6dd', padding: 24 }}>게임 로딩 중…</div>}><GameView choice={choice} onExit={() => setScreen('lobby')} /></Suspense>}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function OfflineArena() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let game: { destroy(removeCanvas?: boolean): void } | undefined;
    void import('./game/createGame').then(({ createGame }) => {
      if (!disposed && containerRef.current) game = createGame(containerRef.current);
    });
    return () => {
      disposed = true;
      game?.destroy(true);
    };
  }, []);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
