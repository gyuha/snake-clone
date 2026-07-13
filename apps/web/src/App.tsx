import { useEffect, useRef, useState } from 'react';
import { createGame } from './game/createGame';
import { GameView } from './ui/GameView';
import { Landing, Lobby, SettingsModal, type LobbyChoice } from './ui/screens';

type Screen = 'landing' | 'lobby' | 'game';

/**
 * 제품 셸 (PRD §7.1): 랜딩 → 로비 → 게임 → (결과) → 재도전/로비.
 * `?mode=offline` 은 M1 오프라인 아레나를 직접 띄운다 (개발/데모용).
 */
export function App() {
  const offline = new URLSearchParams(window.location.search).get('mode') === 'offline';
  if (offline) return <OfflineArena />;
  return <ProductShell />;
}

function ProductShell() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [choice, setChoice] = useState<LobbyChoice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#101418' }}>
      {screen === 'landing' && <Landing onPlay={() => setScreen('lobby')} />}
      {screen === 'lobby' && (
        <Lobby
          onEnter={(c) => {
            setChoice(c);
            setScreen('game');
          }}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {screen === 'game' && choice && <GameView choice={choice} onExit={() => setScreen('lobby')} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function OfflineArena() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const game = createGame(containerRef.current);
    return () => {
      game.destroy(true);
    };
  }, []);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
