import { useEffect, useState } from 'react';
import { validateNickname } from '@serpent/api/nickname';
import { SKINS } from '../skins';
import { acceptFriendInvite, apiBase, claimMission, claimSeasonLevel, createFriendInvite, deleteAccount, ensureGuestSession, fetchCosmetics, fetchFriends, fetchLeaderboard, fetchMatchRegions, fetchMissions, fetchProfile, fetchSeasonProgress, saveLoadout, type Friend, type Leaderboard, type MatchRegion, type Mission, type PlayerProfile, type SeasonProgress } from '../lib/session';

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
  const [policy, setPolicy] = useState<'privacy' | 'terms' | null>(null);
  return (
    <div style={center} data-testid="landing">
      <h1 style={{ color: '#6fd79a', fontFamily: 'monospace', fontSize: 40, margin: 0 }}>
        SERPENT ARENA
      </h1>
      <p style={{ color: '#8aa0b8', fontFamily: 'monospace', textAlign: 'center', margin: 0 }}>
        먹고, 자라고, 상대를 유인하라.
        <br />
        마우스/WASD/게임패드 이동 · Space/클릭/A·RT 부스트
      </p>
      <button style={button} data-testid="play-button" onClick={onPlay}>
        PLAY
      </button>
      <p style={{ color: '#4a5a68', fontSize: 12, fontFamily: 'monospace' }}>
        게스트로 즉시 시작됩니다 · 봇이 포함될 수 있습니다
      </p>
      <div style={{ display: 'flex', gap: 12, fontFamily: 'monospace', fontSize: 12 }}>
        <button type="button" onClick={() => setPolicy('terms')} style={policyLink}>이용 규칙</button>
        <button type="button" onClick={() => setPolicy('privacy')} style={policyLink}>개인정보 안내</button>
      </div>
      {policy && <PolicyModal kind={policy} onClose={() => setPolicy(null)} />}
    </div>
  );
}

const policyLink: React.CSSProperties = { color: '#8aa0b8', background: 'transparent', border: 'none', textDecoration: 'underline', cursor: 'pointer', fontFamily: 'monospace', minHeight: 44 };

function PolicyModal({ kind, onClose }: { kind: 'privacy' | 'terms'; onClose: () => void }) {
  const privacy = kind === 'privacy';
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="policy-title" style={{ ...center, zIndex: 50, background: 'rgba(0,0,0,0.78)' }}>
      <div style={{ ...panel, maxWidth: 560, lineHeight: 1.6 }}>
        <h2 id="policy-title" style={{ marginTop: 0, color: '#6fd79a' }}>{privacy ? '개인정보 안내' : '이용 규칙'}</h2>
        {privacy ? (
          <p style={{ color: '#d8e6dd' }}>
            Serpent Arena는 게스트 ID와 게임 전적을 서비스 제공 목적으로 처리합니다. 이메일·전화번호는 계정 연결을 선택한 경우에만 검증 제공자에 전달되며, 원문은 저장하지 않습니다. 분석 이벤트는 게임 품질 개선을 위해 최소화해 수집하고 보존 기간을 제한합니다. 설정 화면에서 계정과 진행 데이터 삭제를 요청할 수 있습니다.
          </p>
        ) : (
          <p style={{ color: '#d8e6dd' }}>
            공정한 플레이를 위해 자동화·패킷 변조·타인 사칭·괴롭힘을 금지합니다. 닉네임과 신고는 운영 검토 대상이며, 반복적인 부정 입력이나 악용은 연결 제한 또는 제재로 이어질 수 있습니다. 이 게임에는 봇이 포함될 수 있으며, 실시간 경기 결과는 서버 판정을 따릅니다.
          </p>
        )}
        <button autoFocus style={button} onClick={onClose}>확인</button>
      </div>
    </div>
  );
}

// ── S-02 로비 ──────────────────────────────────────────────────────────────
export interface LobbyChoice {
  nickname: string;
  skinId: number;
  preferredRegion: string;
}

export function Lobby({ onEnter, onSettings }: { onEnter: (c: LobbyChoice) => void; onSettings: () => void }) {
  const [nickname, setNickname] = useState(() => window.localStorage.getItem('serpent.nickname') ?? '');
  const [skinId, setSkinId] = useState(() => Number(window.localStorage.getItem('serpent.skin') ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [profileError, setProfileError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [scope, setScope] = useState<Leaderboard['scope']>('daily');
  const [missions, setMissions] = useState<Mission[]>([]);
  const [ownedSkinIds, setOwnedSkinIds] = useState<number[]>(() => SKINS.filter((skin) => skin.id < 8).map((skin) => skin.id));
  const [friends, setFriends] = useState<Friend[]>([]);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [regions, setRegions] = useState<MatchRegion[]>([]);
  const [preferredRegion, setPreferredRegion] = useState('auto');
  const [season, setSeason] = useState<SeasonProgress | null>(null);
  const [seasonTrack, setSeasonTrack] = useState<{ level: number; matches: number; skinId: number }[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const base = apiBase();
        const session = await ensureGuestSession(base);
        const inviteToken = new URLSearchParams(window.location.search).get('invite');
        if (inviteToken) {
          await acceptFriendInvite(base, session.accessToken, inviteToken);
          const url = new URL(window.location.href); url.searchParams.delete('invite'); window.history.replaceState({}, '', url);
        }
        const [current, cosmetics, friendList] = await Promise.all([fetchProfile(base, session.accessToken), fetchCosmetics(base, session.accessToken), fetchFriends(base, session.accessToken)]);
        if (active) { setProfile(current); setOwnedSkinIds(cosmetics.skins.filter((skin) => skin.owned).map((skin) => skin.id)); setSkinId(cosmetics.selectedSkinId); setFriends(friendList); if (inviteToken) setInviteNotice('친구 초대를 수락했습니다.'); }
      } catch {
        if (active) setProfileError(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const base = apiBase();
        const session = await ensureGuestSession(base);
        const board = await fetchLeaderboard(base, session.accessToken, scope);
        if (active) setLeaderboard(board);
      } catch { if (active) setLeaderboard(null); }
    })();
    return () => { active = false; };
  }, [scope]);

  useEffect(() => { let active = true; void (async () => { try { const base=apiBase(); const session=await ensureGuestSession(base); const list=await fetchMissions(base,session.accessToken); if(active) setMissions(list); } catch { /* optional */ } })(); return () => { active=false; }; }, []);
  useEffect(() => { let active = true; void (async () => { try { const base=apiBase(); const session=await ensureGuestSession(base); const response=await fetchSeasonProgress(base,session.accessToken); if(active) { setSeason(response.progress); setSeasonTrack(response.freeTrack); } } catch { /* optional */ } })(); return () => { active=false; }; }, []);
  useEffect(() => { let active = true; void fetchMatchRegions(apiBase()).then((list) => { if (active) setRegions(list); }).catch(() => undefined); return () => { active = false; }; }, []);
  const claim = async (id: string) => { try { const base=apiBase(); const session=await ensureGuestSession(base); await claimMission(base,session.accessToken,id); const cosmetics=await fetchCosmetics(base,session.accessToken); setOwnedSkinIds(cosmetics.skins.filter((skin)=>skin.owned).map((skin)=>skin.id)); setMissions((old) => old.map((m) => m.id===id ? {...m,claimed:true}:m)); } catch { setError('보상 수령에 실패했습니다.'); } };
  const shareInvite = async () => { try { const base=apiBase(); const session=await ensureGuestSession(base); const inviteToken=await createFriendInvite(base,session.accessToken); const url=new URL(window.location.href); url.searchParams.set('invite',inviteToken); await navigator.clipboard?.writeText(url.toString()); setInviteNotice('친구 초대 링크를 클립보드에 복사했습니다. (24시간 유효)'); } catch { setInviteNotice('초대 링크를 만들지 못했습니다.'); } };
  const claimSeason = async (level: number) => { try { const base=apiBase(); const session=await ensureGuestSession(base); await claimSeasonLevel(base,session.accessToken,level); const [next, cosmetics]=await Promise.all([fetchSeasonProgress(base,session.accessToken),fetchCosmetics(base,session.accessToken)]); setSeason(next.progress); setSeasonTrack(next.freeTrack); setOwnedSkinIds(cosmetics.skins.filter((skin)=>skin.owned).map((skin)=>skin.id)); } catch { setError('시즌 보상 수령에 실패했습니다.'); } };

  const submit = async () => {
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
    setSaving(true);
    try {
      const base = apiBase();
      const session = await ensureGuestSession(base);
      await saveLoadout(base, session.accessToken, result.normalized, skinId);
      window.localStorage.setItem('serpent.nickname', result.normalized);
      window.localStorage.setItem('serpent.skin', String(skinId));
      onEnter({ nickname: result.normalized, skinId, preferredRegion });
    } catch {
      setError('프로필 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
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
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
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
              onClick={() => ownedSkinIds.includes(skin.id) && setSkinId(skin.id)}
              title={ownedSkinIds.includes(skin.id) ? skin.name : `${skin.name} · 미션 보상`}
              aria-label={ownedSkinIds.includes(skin.id) ? skin.name : `${skin.name} 잠김`}
              disabled={!ownedSkinIds.includes(skin.id)}
              style={{
                height: 44, borderRadius: 8, cursor: ownedSkinIds.includes(skin.id) ? 'pointer' : 'not-allowed', background: skin.css,
                opacity: ownedSkinIds.includes(skin.id) ? 1 : 0.35, border: skinId === skin.id ? '3px solid #ffffff' : '2px solid #2a3a44',
              }}
            >{ownedSkinIds.includes(skin.id) ? '' : '🔒'}</button>
          ))}
        </div>
        {missions.map((mission) => <div key={mission.id} style={{ marginTop: 10, padding: '10px 12px', background: '#101418', borderRadius: 7, fontSize: 13 }}>
          <strong>{mission.title}</strong> · {mission.progress}/{mission.target} {mission.reward === 'skin:8' && <span style={{ color: '#cdb7ff' }}>· 네뷸라 스킨</span>}{mission.reward === 'skin:9' && <span style={{ color: '#9ff5db' }}>· 오로라 스킨</span>}
          {mission.progress >= mission.target && !mission.claimed && <button style={{ marginLeft: 8 }} onClick={() => void claim(mission.id)}>보상 받기</button>}
          {mission.claimed && <span style={{ marginLeft: 8, color: '#6fd79a' }}>수령 완료</span>}
        </div>)}
        {season && <div style={{ marginTop: 10, padding: '10px 12px', background: '#101418', borderRadius: 7, fontSize: 13 }} data-testid="season-track">
          <strong>{season.season.title} 무료 트랙</strong> · {season.matches}경기
          {seasonTrack.map((tier) => <div key={tier.level} style={{ marginTop: 5 }}>Lv.{tier.level} · {tier.matches}경기 · 스킨 {tier.skinId}
            {season.matches >= tier.matches && !season.claimedLevels.includes(tier.level) && <button style={{ marginLeft: 8 }} onClick={() => void claimSeason(tier.level)}>받기</button>}
            {season.claimedLevels.includes(tier.level) && <span style={{ marginLeft: 8, color: '#6fd79a' }}>수령 완료</span>}
          </div>)}
        </div>}
        <div style={{ marginTop: 10, padding: '10px 12px', background: '#101418', borderRadius: 7, fontSize: 13 }} data-testid="friends">
          <strong>친구</strong> · {friends.length ? friends.map((friend) => friend.nickname ?? '익명 뱀').join(', ') : '아직 없습니다'}
          <button style={{ marginLeft: 8 }} onClick={() => void shareInvite()}>초대 링크</button>
          {inviteNotice && <div style={{ color: '#8aa0b8', marginTop: 5 }}>{inviteNotice}</div>}
        </div>
        <div
          data-testid="lobby-stats"
          style={{ marginTop: 18, padding: '10px 12px', background: '#101418', borderRadius: 7, color: '#8aa0b8', fontSize: 13 }}
          aria-live="polite"
        >
          {profile ? (
            <>전적 · {profile.stats.games} 경기 · 최고 {profile.stats.bestScore.toLocaleString()}점 · 최장 {Math.floor(profile.stats.bestSurvivalMs / 1000)}초</>
          ) : profileError ? (
            <>전적을 불러올 수 없습니다. 게임은 계속 시작할 수 있습니다.</>
          ) : (
            <>전적 불러오는 중…</>
          )}
        </div>
        <label style={{ display: 'block', marginTop: 14, color: '#8aa0b8' }}>지역
          <select value={preferredRegion} onChange={(event) => setPreferredRegion(event.target.value)} style={{ marginLeft: 10, fontFamily: 'monospace' }} aria-label="매칭 지역">
            <option value="auto">자동 (최저 지연)</option>
            {regions.map((region) => <option key={region.region} value={region.region}>{region.region} · {region.averageRttMs ?? '?'}ms · {region.players}/{region.capacity}</option>)}
          </select>
        </label>
        <div style={{ marginTop: 14, padding: '10px 12px', background: '#101418', borderRadius: 7, color: '#d8e6dd', fontSize: 13 }} data-testid="leaderboard">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>리더보드</strong>
            <select value={scope} onChange={(event) => setScope(event.target.value as Leaderboard['scope'])} aria-label="리더보드 기간">
              <option value="daily">오늘</option><option value="weekly">이번 주</option><option value="all">전체</option>
            </select>
          </div>
          {leaderboard ? <>
            <ol style={{ margin: '8px 0 0', paddingLeft: 24 }}>
              {leaderboard.entries.slice(0, 5).map((entry) => <li key={entry.userId}>{entry.nickname ?? '익명 뱀'} · {entry.score.toLocaleString()}</li>)}
              {leaderboard.entries.length === 0 && <li>아직 기록이 없습니다</li>}
            </ol>
            <div style={{ color: '#8aa0b8', marginTop: 6 }}>내 순위: {leaderboard.selfRank ?? '기록 없음'}</div>
          </> : <div style={{ color: '#8aa0b8', marginTop: 8 }}>리더보드 불러오는 중…</div>}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button style={{ ...button, flex: 1, opacity: saving ? 0.65 : 1 }} data-testid="enter-button" onClick={() => void submit()} disabled={saving}>
            {saving ? '준비 중…' : '입장 (Quick Play)'}
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
  reduceMotion: boolean;
  highContrast: boolean;
  oneHanded: boolean;
}

export function loadSettings(): Settings {
  try {
    return { volume: 0.8, quality: 'high', reduceMotion: false, highContrast: false, oneHanded: false, ...JSON.parse(window.localStorage.getItem('serpent.settings') ?? '{}') };
  } catch {
    return { volume: 0.8, quality: 'high', reduceMotion: false, highContrast: false, oneHanded: false };
  }
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem('serpent.settings', JSON.stringify(settings));
  }, [settings]);

  const removeAccount = async () => {
    if (!window.confirm('계정과 진행 데이터를 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    setDeleting(true); setDeleteError(null);
    try {
      const base = apiBase(); const session = await ensureGuestSession(base);
      await deleteAccount(base, session.accessToken);
      window.location.reload();
    } catch { setDeleteError('계정 삭제에 실패했습니다. 잠시 후 다시 시도해 주세요.'); setDeleting(false); }
  };

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
        <label style={{ display: 'block', marginTop: 14, color: '#8aa0b8' }}>
          <input type="checkbox" checked={settings.highContrast} onChange={(e) => setSettings((s) => ({ ...s, highContrast: e.target.checked }))} /> 색약 친화 외곽선
        </label>
        <label style={{ display: 'block', marginTop: 10, color: '#8aa0b8' }}>
          <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => setSettings((s) => ({ ...s, reduceMotion: e.target.checked }))} /> 화면 이동·보간 줄이기
        </label>
        <label style={{ display: 'block', marginTop: 10, color: '#8aa0b8' }}>
          <input type="checkbox" checked={settings.oneHanded} onChange={(e) => setSettings((s) => ({ ...s, oneHanded: e.target.checked }))} /> 오른손 한손 조작 (조이스틱·부스트 세로 배치)
        </label>
        <button style={{ ...button, marginTop: 22 }} data-testid="settings-close" onClick={onClose}>
          닫기
        </button>
        <button style={{ ...button, marginTop: 10, width: '100%', background: '#7c3341', color: '#fff', fontSize: 14 }} onClick={() => void removeAccount()} disabled={deleting}>
          {deleting ? '삭제 중…' : '계정 및 진행 데이터 삭제'}
        </button>
        {deleteError && <p style={{ color: '#e87f8e', fontSize: 12 }}>{deleteError}</p>}
      </div>
    </div>
  );
}
