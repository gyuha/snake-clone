import { useEffect, useState } from 'react';
import { validateNickname } from '@serpent/api/nickname';
import { SKINS } from '../skins';

/** 공용 스타일 */
const panel: React.CSSProperties = {
  background: '#18222b',
  border: '1px solid #2a3a44',
  borderRadius: 12,
  padding: 28,
  color: '#d8e6dd',
  fontFamily: 'monospace',
  maxWidth: 420,
  width: '90%',
};

const button: React.CSSProperties = {
  background: '#4ea56f',
  color: '#0c1216',
  border: 'none',
  borderRadius: 8,
  padding: '12px 28px',
  fontSize: 18,
  fontFamily: 'monospace',
  fontWeight: 700,
  cursor: 'pointer',
  minHeight: 44, // §7.4 모바일 버튼 최소 크기
};

const center: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  gap: 16,
  background: '#101418',
};

// ── S-01 랜딩 ──────────────────────────────────────────────────────────────
export function Landing({ onPlay }: { onPlay: () => void }) {
  return (
    <div style={center} data-testid="landing">
      <h1 style={{ color: '#6fd79a', fontFamily: 'monospace', fontSize: 40, margin: 0 }}>
        SERPENT ARENA
      </h1>
      <p style={{ color: '#8aa0b8', fontFamily: 'monospace', textAlign: 'center', margin: 0 }}>
        먹고, 자라고, 상대를 유인하라.
        <br />
        마우스/WASD 이동 · Space/클릭 부스트
      </p>
      <button style={button} data-testid="play-button" onClick={onPlay}>
        PLAY
      </button>
      <p style={{ color: '#4a5a68', fontSize: 12, fontFamily: 'monospace' }}>
        게스트로 즉시 시작됩니다 · 봇이 포함될 수 있습니다
      </p>
    </div>
  );
}

// ── S-02 로비 ──────────────────────────────────────────────────────────────
export interface LobbyChoice {
  nickname: string;
  skinId: number;
}

export function Lobby({ onEnter, onSettings }: { onEnter: (c: LobbyChoice) => void; onSettings: () => void }) {
  const [nickname, setNickname] = useState(() => window.localStorage.getItem('serpent.nickname') ?? '');
  const [skinId, setSkinId] = useState(() => Number(window.localStorage.getItem('serpent.skin') ?? 0));
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const name = nickname.trim() || `뱀${Math.floor(Math.random() * 1000)}`;
    const result = validateNickname(name);
    if (!result.ok) {
      setError(
        result.error === 'banned_word'
          ? '사용할 수 없는 닉네임입니다'
          : '닉네임은 2~16자의 한글/영문/숫자/_-만 가능합니다',
      );
      return;
    }
    window.localStorage.setItem('serpent.nickname', result.normalized);
    window.localStorage.setItem('serpent.skin', String(skinId));
    onEnter({ nickname: result.normalized, skinId });
  };

  return (
    <div style={center} data-testid="lobby">
      <div style={panel}>
        <h2 style={{ marginTop: 0, color: '#6fd79a' }}>출전 준비</h2>
        <label style={{ display: 'block', marginBottom: 6, color: '#8aa0b8' }}>닉네임</label>
        <input
          data-testid="nickname-input"
          value={nickname}
          onChange={(e) => {
            setNickname(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="2~16자"
          style={{
            width: '100%', boxSizing: 'border-box', padding: 10, fontSize: 16,
            fontFamily: 'monospace', background: '#101418', color: '#d8e6dd',
            border: '1px solid #2a3a44', borderRadius: 6,
          }}
        />
        {error && (
          <p data-testid="nickname-error" style={{ color: '#e87f8e', fontSize: 13 }}>
            {error}
          </p>
        )}
        <label style={{ display: 'block', margin: '16px 0 6px', color: '#8aa0b8' }}>스킨</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }} data-testid="skin-grid">
          {SKINS.map((skin) => (
            <button
              key={skin.id}
              data-testid={`skin-${skin.id}`}
              onClick={() => setSkinId(skin.id)}
              title={skin.name}
              style={{
                height: 44, borderRadius: 8, cursor: 'pointer', background: skin.css,
                border: skinId === skin.id ? '3px solid #ffffff' : '2px solid #2a3a44',
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button style={{ ...button, flex: 1 }} data-testid="enter-button" onClick={submit}>
            입장 (Quick Play)
          </button>
          <button
            style={{ ...button, background: '#2a3a44', color: '#d8e6dd' }}
            data-testid="settings-button"
            onClick={onSettings}
          >
            설정
          </button>
        </div>
      </div>
    </div>
  );
}

// ── S-06 설정 ──────────────────────────────────────────────────────────────
export interface Settings {
  volume: number;
  quality: 'high' | 'low';
}

export function loadSettings(): Settings {
  try {
    return { volume: 0.8, quality: 'high', ...JSON.parse(window.localStorage.getItem('serpent.settings') ?? '{}') };
  } catch {
    return { volume: 0.8, quality: 'high' };
  }
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    window.localStorage.setItem('serpent.settings', JSON.stringify(settings));
  }, [settings]);

  return (
    <div style={{ ...center, background: 'rgba(0,0,0,0.7)', zIndex: 40 }} data-testid="settings-modal">
      <div style={panel}>
        <h2 style={{ marginTop: 0, color: '#6fd79a' }}>설정</h2>
        <label style={{ display: 'block', color: '#8aa0b8' }}>
          음량 {Math.round(settings.volume * 100)}%
          <input
            type="range" min={0} max={1} step={0.05} value={settings.volume}
            onChange={(e) => setSettings((s) => ({ ...s, volume: Number(e.target.value) }))}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ display: 'block', marginTop: 14, color: '#8aa0b8' }}>
          그래픽 품질
          <select
            value={settings.quality}
            onChange={(e) => setSettings((s) => ({ ...s, quality: e.target.value as Settings['quality'] }))}
            style={{ marginLeft: 10, fontFamily: 'monospace' }}
          >
            <option value="high">높음 (60FPS)</option>
            <option value="low">낮음 (30FPS·배터리 절약)</option>
          </select>
        </label>
        <button style={{ ...button, marginTop: 22 }} data-testid="settings-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
