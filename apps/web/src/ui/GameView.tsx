import { useEffect, useRef, useState } from 'react';
import Phaser from 'phaser';
import type { LeaderboardMessage, ResultMessage } from '@serpent/protocol';
import type { GameBridge } from '../game/bridge';
import { OnlineScene, type OnlineStartData } from '../game/OnlineScene';
import { browserSupportsGameRendering } from '../game/renderSupport';
import { fullscreenSupported, toggleFullscreen } from '../game/fullscreen';
import { formatScore } from '../lib/formatScore';
import { apiBase, ensureGuestSession, fetchActiveEvent, fetchAnnouncement, fetchClientConfig, requestTicket, sendTelemetry, submitReport, type Announcement, type FunnelEventName, type LiveEvent } from '../lib/session';
import type { LobbyChoice } from './screens';

function renderSettings(): { volume: number; quality: 'high' | 'low'; reduceMotion: boolean; highContrast: boolean; oneHanded: boolean } {
  try {
    const saved = JSON.parse(window.localStorage.getItem('serpent.settings') ?? '{}') as Partial<{ volume: number; quality: 'high' | 'low'; reduceMotion: boolean; highContrast: boolean; oneHanded: boolean }>;
    return { volume: typeof saved.volume === 'number' ? Math.max(0, Math.min(1, saved.volume)) : 0.8, quality: saved.quality === 'low' ? 'low' : 'high', reduceMotion: saved.reduceMotion === true, highContrast: saved.highContrast === true, oneHanded: saved.oneHanded === true };
  } catch { return { volume: 0.8, quality: 'high', reduceMotion: false, highContrast: false, oneHanded: false }; }
}

const mono: React.CSSProperties = { fontFamily: 'monospace' };

interface HudState {
  score: number;
  length: number;
  kills: number;
  rttMs: number | null;
  snapshotStale: boolean;
}

/**
 * S-04 게임 화면: Phaser 캔버스 + React 오버레이(HUD/리더보드/결과).
 * api 게스트 → 티켓 → joinToken 입장 플로우를 수행한다 (PRD §3.2).
 */
export function GameView({ choice, onExit }: { choice: LobbyChoice; onExit: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<GameBridge | null>(null);
  const trackRef = useRef<((name: FunnelEventName) => void) | null>(null);
  const [status, setStatus] = useState('매칭 중...');
  const [hud, setHud] = useState<HudState>({ score: 0, length: 0, kills: 0, rttMs: null, snapshotStale: false });
  const [leaderboard, setLeaderboard] = useState<LeaderboardMessage | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [bestScore, setBestScore] = useState(() => Number(window.localStorage.getItem('serpent.best') ?? 0));
  const [lbCollapsed, setLbCollapsed] = useState(false);
  const [matching, setMatching] = useState(true);
  const [slowMatch, setSlowMatch] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [liveEvent, setLiveEvent] = useState<LiveEvent | null>(null);
  const [configMismatch, setConfigMismatch] = useState<string | null>(null);
  const [portraitTouch, setPortraitTouch] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ id: string; name: string } | null>(null);
  const canFullscreen = fullscreenSupported(document);

  useEffect(() => {
    const update = () => setPortraitTouch(window.matchMedia('(pointer: coarse)').matches && window.innerHeight > window.innerWidth);
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); };
  }, []);

  useEffect(() => {
    let game: Phaser.Game | null = null;
    let cancelled = false;
    let joinedTimer: number | undefined;
    const attemptStartedAt = Date.now();
    setMatching(true);
    setSlowMatch(false);
    setUnsupported(false);
    setStatus('매칭 준비 중...');
    if (!browserSupportsGameRendering()) {
      setMatching(false);
      setUnsupported(true);
      setStatus('이 브라우저는 Canvas 또는 WebGL을 지원하지 않습니다.');
      return () => { cancelled = true; };
    }
    const slowTimer = window.setTimeout(() => {
      if (!cancelled) setSlowMatch(true);
    }, 15_000);

    const bridge: GameBridge = {
      onLeaderboard: setLeaderboard,
      onResult: (r) => {
        setResult(r);
        if (r) trackRef.current?.('match_ended');
        if (r && r.score > Number(window.localStorage.getItem('serpent.best') ?? 0)) {
          window.localStorage.setItem('serpent.best', String(r.score));
          setBestScore(r.score);
        }
      },
      onStatus: setStatus,
      onHud: setHud,
      onRoomJoined: () => {
        // 초고속 로컬 연결에서도 S-03 진행 상태가 눈에 보이도록 짧게 유지한다.
        // 취소/재시도 때는 cleanup에서 반드시 제거한다.
        joinedTimer = window.setTimeout(() => setMatching(false), Math.max(0, 350 - (Date.now() - attemptStartedAt)));
        trackRef.current?.('room_joined');
      },
      onFirstInput: () => trackRef.current?.('first_input'),
      onConfigMismatch: (serverVersion) => { setMatching(false); setConfigMismatch(serverVersion); },
    };
    bridgeRef.current = bridge;

    (async () => {
      try {
        const base = apiBase();
        void fetchAnnouncement(base).then(setAnnouncement).catch(() => undefined);
        const session = await ensureGuestSession(base);
        trackRef.current = (name) => { void sendTelemetry(base, session.accessToken, name).catch(() => undefined); };
        setStatus('게임 설정 확인 중...');
        const clientConfig = await fetchClientConfig(base);
        setStatus('가까운 서버를 찾는 중...');
        const ticket = await requestTicket(base, session.accessToken, choice.preferredRegion);
        if (clientConfig.features.eventHud) void fetchActiveEvent(base, ticket.region).then(setLiveEvent).catch(() => undefined);
        trackRef.current('ticket_created');
        if (cancelled || !containerRef.current) return;
        const data: OnlineStartData = {
          endpoint: ticket.endpoint,
          roomName: ticket.roomName,
          joinToken: ticket.joinToken,
          nickname: choice.nickname,
          skinId: choice.skinId,
          config: clientConfig.config,
          ...renderSettings(),
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
        setSlowMatch(true);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(slowTimer);
      if (joinedTimer !== undefined) window.clearTimeout(joinedTimer);
      trackRef.current = null;
      bridgeRef.current?.leaveGame?.();
      game?.destroy(true);
    };
  }, [choice, attempt]);

  const isNewBest = result !== null && result.score >= bestScore && result.score > 0;

  return (
    <div style={{ position: 'absolute', inset: 0 }} data-testid="game">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {canFullscreen && !result && (
        <button
          data-testid="fullscreen-toggle"
          aria-label="전체 화면 전환"
          onClick={() => { if (containerRef.current) void toggleFullscreen(containerRef.current, document); }}
          style={{ ...mono, position: 'absolute', right: 12, bottom: 12, zIndex: 20, background: 'rgba(16,20,24,0.82)', color: '#d8e6dd', border: '1px solid #4a5a68', borderRadius: 6, padding: '8px 10px', minHeight: 44, cursor: 'pointer' }}
        >
          전체 화면
        </button>
      )}

      {/* S-03: 실제 티켓/Room 접속 단계를 막지 않는 매칭 진행 UI. 15초 후에는
          사용자가 무한 대기하지 않고 재시도 또는 로비로 돌아갈 수 있다. */}
      {matching && !result && (
        <div
          data-testid="matching"
          style={{
            position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(16,20,24,0.88)', ...mono, color: '#d8e6dd',
          }}
        >
          <div style={{ width: 'min(400px, 88vw)', textAlign: 'center', padding: 28, border: '1px solid #2a3a44', borderRadius: 12, background: '#18222b' }}>
            <h2 style={{ margin: 0, color: '#6fd79a' }}>Quick Play 매칭</h2>
            <p data-testid="matching-status" aria-live="polite" style={{ color: '#8aa0b8' }}>{status || '서버에 연결 중...'}</p>
            {!slowMatch ? <div aria-label="매칭 진행률" style={{ height: 6, borderRadius: 4, overflow: 'hidden', background: '#101418' }}><div style={{ width: '65%', height: '100%', background: '#4ea56f' }} /></div> : (
              <p style={{ color: '#e8d377', fontSize: 13, lineHeight: 1.5 }}>
                15초 이상 걸리고 있습니다. 네트워크를 확인한 뒤 자동 지역 선택으로 다시 시도하거나 로비로 돌아가세요.
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 20 }}>
              {slowMatch && <button data-testid="matching-retry" onClick={() => setAttempt((value) => value + 1)} style={{ ...mono, background: '#4ea56f', color: '#0c1216', border: 'none', borderRadius: 8, padding: '10px 16px', minHeight: 44, cursor: 'pointer' }}>자동 지역 재시도</button>}
              <button data-testid="matching-cancel" onClick={onExit} style={{ ...mono, background: '#2a3a44', color: '#d8e6dd', border: 'none', borderRadius: 8, padding: '10px 16px', minHeight: 44, cursor: 'pointer' }}>취소</button>
            </div>
          </div>
        </div>
      )}

      {configMismatch && (
        <div data-testid="config-mismatch" style={{ position: 'absolute', inset: 0, zIndex: 35, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,20,24,0.92)', ...mono, color: '#d8e6dd' }}>
          <div style={{ maxWidth: 420, textAlign: 'center', padding: 28, border: '1px solid #e8d377', borderRadius: 12, background: '#18222b' }}>
            <h2 style={{ marginTop: 0, color: '#e8d377' }}>게임 업데이트 필요</h2>
            <p>서버 설정({configMismatch})이 현재 클라이언트와 다릅니다. 새 버전을 받아 다시 연결하세요.</p>
            <button data-testid="config-reload" onClick={() => window.location.reload()} style={{ ...mono, background: '#4ea56f', color: '#0c1216', border: 'none', borderRadius: 8, padding: '12px 20px', minHeight: 44, cursor: 'pointer' }}>새로고침</button>
          </div>
        </div>
      )}
      {unsupported && (
        <div data-testid="unsupported-browser" style={{ position: 'absolute', inset: 0, zIndex: 35, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,20,24,0.92)', ...mono, color: '#d8e6dd' }}>
          <div style={{ maxWidth: 420, textAlign: 'center', padding: 28, border: '1px solid #e8d377', borderRadius: 12, background: '#18222b' }}>
            <h2 style={{ marginTop: 0, color: '#e8d377' }}>지원되지 않는 브라우저</h2>
            <p>Canvas 또는 WebGL을 사용할 수 없습니다. 최신 Chrome, Edge, Safari, Firefox로 다시 시도해 주세요.</p>
            <button onClick={onExit} style={{ ...mono, background: '#4ea56f', color: '#0c1216', border: 'none', borderRadius: 8, padding: '12px 20px', minHeight: 44, cursor: 'pointer' }}>로비로 돌아가기</button>
          </div>
        </div>
      )}
      {portraitTouch && !result && !configMismatch && (
        <div data-testid="orientation-hint" style={{ ...mono, position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 25, color: '#d8e6dd', background: 'rgba(16,20,24,0.88)', border: '1px solid #4a5a68', borderRadius: 8, padding: '8px 12px', fontSize: 12, pointerEvents: 'none' }}>
          더 넓게 보려면 기기를 가로로 돌려 주세요
        </div>
      )}

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
        {hud.snapshotStale && (
          <div data-testid="snapshot-warning" role="status" style={{ color: '#e8d377', fontSize: 12 }}>
            연결 품질 저하 · 상태 동기화 대기 중
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
            <div key={e.id} data-testid={`lb-row-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                {i + 1}. {e.name}
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {formatScore(e.score)}
                {leaderboard.selfRank !== i + 1 && <button type="button" onClick={() => setReportTarget({ id: e.id, name: e.name })} aria-label={`${e.name} 신고`} style={{ fontSize: 11, padding: '2px 5px', cursor: 'pointer' }}>신고</button>}
              </span>
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
      {announcement && !result && (
        <div data-testid="announcement" style={{ ...mono, position: 'absolute', top: status ? 48 : 10, left: '50%', transform: 'translateX(-50%)', zIndex: 10, maxWidth: 'min(680px, 86vw)', textAlign: 'center', color: '#d8e6dd', background: 'rgba(16,20,24,0.82)', border: '1px solid #4a5a68', borderRadius: 6, padding: '6px 12px', fontSize: 13 }}>
          공지 · {announcement.message}
        </div>
      )}
      {liveEvent && !result && (
        <div data-testid="live-event" style={{ ...mono, position: 'absolute', top: announcement || status ? 78 : 10, left: '50%', transform: 'translateX(-50%)', zIndex: 10, maxWidth: 'min(680px, 86vw)', textAlign: 'center', color: '#9ff5db', background: 'rgba(16,20,24,0.82)', border: '1px solid #46bfa3', borderRadius: 6, padding: '6px 12px', fontSize: 13 }}>
          {liveEvent.theme} 이벤트 · {liveEvent.title} · {Math.max(0, Math.ceil((liveEvent.endsAt - Date.now()) / 3_600_000))}시간 남음
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
              onClick={() => {
                trackRef.current?.('retry_click');
                bridgeRef.current?.requestRespawn?.();
              }}
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
      {reportTarget && <ReportModal target={reportTarget} onClose={() => setReportTarget(null)} />}
    </div>
  );
}

function ReportModal({ target, onClose }: { target: { id: string; name: string }; onClose: () => void }) {
  const [reason, setReason] = useState<'abuse' | 'cheating' | 'inappropriate_name' | 'other'>('cheating');
  const [detail, setDetail] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const submit = async () => {
    setStatus('제출 중…');
    try {
      const base = apiBase();
      const session = await ensureGuestSession(base);
      const suffix = detail.trim();
      await submitReport(base, session.accessToken, {
        reason,
        detail: `room player: ${target.name} (${target.id})${suffix ? ` — ${suffix}` : ''}`,
      });
      setStatus('신고가 접수되었습니다. 운영 검토에 사용됩니다.');
    } catch {
      setStatus('신고를 제출하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="report-title" style={{ position: 'absolute', inset: 0, zIndex: 45, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.72)', ...mono, color: '#d8e6dd' }}>
      <div style={{ width: 'min(420px, 88vw)', padding: 24, background: '#18222b', border: '1px solid #4a5a68', borderRadius: 10 }}>
        <h2 id="report-title" style={{ marginTop: 0 }}>신고 · {target.name}</h2>
        <label style={{ display: 'block' }}>사유
          <select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)} style={{ marginLeft: 8 }}>
            <option value="cheating">부정행위 의심</option><option value="abuse">괴롭힘</option><option value="inappropriate_name">부적절한 이름</option><option value="other">기타</option>
          </select>
        </label>
        <textarea value={detail} maxLength={420} onChange={(event) => setDetail(event.target.value)} placeholder="선택 사항: 검토에 도움이 되는 상황을 적어 주세요" style={{ boxSizing: 'border-box', width: '100%', minHeight: 80, marginTop: 12, fontFamily: 'monospace' }} />
        {status && <p aria-live="polite" style={{ fontSize: 12, color: '#8aa0b8' }}>{status}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => void submit()} style={{ ...mono, minHeight: 44 }}>신고 제출</button>
          <button onClick={onClose} style={{ ...mono, minHeight: 44 }}>닫기</button>
        </div>
      </div>
    </div>
  );
}
