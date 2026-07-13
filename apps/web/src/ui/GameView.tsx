import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import type { LeaderboardMessage, ResultMessage } from '@serpent/protocol';
import type { GameBridge } from '../game/bridge';
import { OnlineScene, type OnlineStartData } from '../game/OnlineScene';
import { formatScore } from '../lib/formatScore';
import { apiBase, ensureGuestSession, requestTicket } from '../lib/session';
import type { LobbyChoice } from './screens';

const mono: React.CSSProperties = { fontFamily: 'monospace' };

interface HudState {
  score: number;
  length: number;
  kills: number;
  rttMs: number | null;
}

/**
 * S-04 게임 화면: Phaser 캔버스 + React 오버레이(HUD/리더보드/결과).
 * api 게스트 → 티켓 → joinToken 입장 플로우를 수행한다 (PRD §3.2).
 */
export function GameView({ choice, onExit }: { choice: LobbyChoice; onExit: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<GameBridge | null>(null);
  const [status, setStatus] = useState('매칭 중...');
  const [hud, setHud] = useState<HudState>({ score: 0, length: 0, kills: 0, rttMs: null });
  const [leaderboard, setLeaderboard] = useState<LeaderboardMessage | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [bestScore, setBestScore] = useState(() => Number(window.localStorage.getItem('serpent.best') ?? 0));
  const [lbCollapsed, setLbCollapsed] = useState(false);

  useEffect(() => {
    let game: Phaser.Game | null = null;
    let cancelled = false;

    const bridge: GameBridge = {
      onLeaderboard: setLeaderboard,
      onResult: (r) => {
        setResult(r);
        if (r && r.score > Number(window.localStorage.getItem('serpent.best') ?? 0)) {
          window.localStorage.setItem('serpent.best', String(r.score));
          setBestScore(r.score);
        }
      },
      onStatus: setStatus,
      onHud: setHud,
    };
    bridgeRef.current = bridge;

    (async () => {
      try {
        const base = apiBase();
        const session = await ensureGuestSession(base);
        const ticket = await requestTicket(base, session.accessToken);
        if (cancelled || !containerRef.current) return;
        const data: OnlineStartData = {
          endpoint: ticket.endpoint,
          joinToken: ticket.joinToken,
          nickname: choice.nickname,
          skinId: choice.skinId,
          bridge,
        };
        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: containerRef.current,
          backgroundColor: '#101418',
          scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
        });
        game.scene.add('online', OnlineScene, true, data as unknown as Record<string, unknown>);
      } catch (err) {
        setStatus(`매칭 실패: ${err instanceof Error ? err.message : String(err)} — API 서버 확인 필요`);
      }
    })();

    return () => {
      cancelled = true;
      bridgeRef.current?.leaveGame?.();
      game?.destroy(true);
    };
  }, [choice]);

  const isNewBest = result !== null && result.score >= bestScore && result.score > 0;

  return (
    <div style={{ position: 'absolute', inset: 0 }} data-testid="game">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* 좌상단 HUD: 점수/길이/킬 (4Hz — §7.2) */}
      <div
        data-testid="hud"
        style={{ ...mono, position: 'absolute', top: 10, left: 12, color: '#d8e6dd', fontSize: 15, pointerEvents: 'none' }}
      >
        <div data-testid="hud-score">score {formatScore(hud.score)}</div>
        <div>length {hud.length} · kills {hud.kills}</div>
        {hud.rttMs !== null && (
          <div style={{ color: hud.rttMs > 150 ? '#e8d377' : '#4a5a68', fontSize: 12 }}>
            {hud.rttMs}ms {hud.rttMs > 150 ? '· 연결 지연' : ''}
          </div>
        )}
      </div>

      {/* 우상단 리더보드 Top10 + 본인 (§7.2 — 접기 가능) */}
      <div
        data-testid="leaderboard"
        style={{
          ...mono, position: 'absolute', top: 10, right: 12, color: '#d8e6dd',
          background: 'rgba(16,20,24,0.75)', border: '1px solid #2a3a44', borderRadius: 8,
          padding: '8px 12px', fontSize: 13, minWidth: 160,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setLbCollapsed((c) => !c)}>
          <b style={{ color: '#6fd79a' }}>리더보드</b>
          <span>{lbCollapsed ? '▸' : '▾'}</span>
        </div>
        {!lbCollapsed &&
          leaderboard?.entries.map((e, i) => (
            <div key={e.id} data-testid={`lb-row-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>
                {i + 1}. {e.name}
              </span>
              <span>{formatScore(e.score)}</span>
            </div>
          ))}
        {!lbCollapsed && leaderboard && (
          <div data-testid="self-rank" style={{ borderTop: '1px solid #2a3a44', marginTop: 4, paddingTop: 4, color: '#8aa0b8' }}>
            내 순위 {leaderboard.selfRank > 0 ? leaderboard.selfRank : '-'} / {leaderboard.totalPlayers}
          </div>
        )}
      </div>

      {/* 상단 중앙 상태/경고 (§7.2) */}
      {status && (
        <div
          data-testid="status"
          style={{
            ...mono, position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
            color: '#e8d377', fontSize: 14, background: 'rgba(16,20,24,0.8)', padding: '6px 14px', borderRadius: 6,
          }}
        >
          {status}
        </div>
      )}

      {/* S-05 결과 화면 */}
      {result && (
        <div
          data-testid="result"
          style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, zIndex: 30,
            ...mono, color: '#ffffff',
          }}
        >
          <h2 style={{ margin: 0, color: '#e87f8e' }}>사망! ({result.reason})</h2>
          <div data-testid="result-score" style={{ fontSize: 26 }}>
            점수 {formatScore(result.score)} {isNewBest && <span style={{ color: '#e8d377' }}>★ 최고 기록!</span>}
          </div>
          <div style={{ color: '#8aa0b8' }}>
            순위 {result.rank} · 생존 {Math.round(result.survivalMs / 1000)}초 · 킬 {result.kills} · 길이 {result.length}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
            <button
              data-testid="retry-button"
              onClick={() => bridgeRef.current?.requestRespawn?.()}
              style={{
                ...mono, background: '#4ea56f', color: '#0c1216', border: 'none', borderRadius: 8,
                padding: '12px 30px', fontSize: 18, fontWeight: 700, cursor: 'pointer', minHeight: 44,
              }}
            >
              다시하기
            </button>
            <button
              data-testid="exit-button"
              onClick={onExit}
              style={{
                ...mono, background: '#2a3a44', color: '#d8e6dd', border: 'none', borderRadius: 8,
                padding: '12px 20px', fontSize: 16, cursor: 'pointer', minHeight: 44,
              }}
            >
              로비로
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
