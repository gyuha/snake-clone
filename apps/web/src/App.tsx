import { useEffect, useRef } from 'react';
import { createGame } from './game/createGame';

/**
 * React는 셸(라우팅/로비/설정)을, Phaser는 게임 캔버스를 담당한다 (PRD §10.1).
 * M0에서는 빈 부트 씬만 띄운다.
 */
export function App() {
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
