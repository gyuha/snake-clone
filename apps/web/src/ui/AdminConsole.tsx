import { useCallback, useEffect, useState } from 'react';
import { apiBase } from '../lib/session';

type Room = { roomId: string; configVersion: string; humans: number; bots: number; tickP99Ms: number; averageRttMs: number | null; snapshotP95Bytes: number; aoiEntitiesP95: number; outboundBytesPerSecond: number; errorRate: number; draining: boolean };
type OpsAlert = { severity: 'P1' | 'P2' | 'P3'; code: string; roomId?: string; message: string };
type Ops = { activeRooms: number; humans: number; bots: number; rooms: Room[]; alerts: OpsAlert[]; process?: { rssBytes: number; heapUsedBytes: number; eventLoopLagP99Ms: number; draining?: boolean } };
type Config = { active: { version: string; activatedAt: number; rolloutPercent: number }; history: { version: string; activatedAt: number; rolloutPercent: number }[] };
type Report = { id: string; reporterUserId: string; targetUserId: string | null; reason: string; detail: string | null; createdAt: number };
type Audit = { id: string; action: string; target: string; createdAt: number };
type Announcement = { message: string; updatedAt: number } | null;
type ApiMetrics = { windowMs: number; requests: number; requestsPerSecond: number; latencyP50Ms: number; latencyP95Ms: number; errors5xx: number; errorRate: number; databasePool: { total: number; idle: number; waiting: number; saturation: number } | null };
type ProductMetrics = { windowHours: number; funnel: { name: string; events: number; uniqueUsers: number }[]; matches: { completed: number; uniquePlayers: number; averageSurvivalMs: number }; retention: { d1: { cohort: number; retained: number; rate: number }; d7: { cohort: number; retained: number; rate: number } } };
type Features = { accountLink: boolean; missions: boolean; eventHud: boolean; binaryProtocol: boolean };

const shell: React.CSSProperties = { minHeight: '100%', background: '#101418', color: '#d8e6dd', padding: 24, fontFamily: 'monospace', boxSizing: 'border-box' };
const card: React.CSSProperties = { background: '#18222b', border: '1px solid #2a3a44', borderRadius: 10, padding: 16 };
const action: React.CSSProperties = { minHeight: 40, padding: '8px 12px', borderRadius: 6, border: '1px solid #4ea56f', background: '#183526', color: '#d8e6dd', fontFamily: 'monospace', cursor: 'pointer' };

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { credentials: 'include' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

async function command(path: string, body?: unknown, method = 'POST'): Promise<void> {
  const response = await fetch(`${apiBase()}${path}`, { method, credentials: 'include', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(String(response.status));
}

export function AdminConsole() {
  const [secret, setSecret] = useState('');
  const [totp, setTotp] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [ops, setOps] = useState<Ops | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement>(null);
  const [apiMetrics, setApiMetrics] = useState<ApiMetrics | null>(null);
  const [productMetrics, setProductMetrics] = useState<ProductMetrics | null>(null);
  const [features, setFeatures] = useState<Features | null>(null);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [eventId, setEventId] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventTheme, setEventTheme] = useState('');
  const [eventStartsAt, setEventStartsAt] = useState('');
  const [eventEndsAt, setEventEndsAt] = useState('');
  const [eventRegions, setEventRegions] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [nextOps, nextConfig, nextReports, nextAudit, nextAnnouncement, nextApiMetrics, nextProductMetrics, nextFeatures] = await Promise.all([
        request<Ops>('/v1/admin/ops/metrics'), request<Config>('/v1/admin/config'),
        request<{ reports: Report[] }>('/v1/admin/reports?limit=20'), request<{ entries: Audit[] }>('/v1/admin/audit?limit=20'), request<{ announcement: Announcement }>('/v1/announcements/current'),
        request<ApiMetrics>('/v1/admin/api/metrics'),
        request<ProductMetrics>('/v1/admin/product/metrics?windowHours=24'),
        request<{ features: Features }>('/v1/admin/features'),
      ]);
      setOps(nextOps); setConfig(nextConfig); setReports(nextReports.reports); setAudit(nextAudit.entries); setAnnouncement(nextAnnouncement.announcement); setApiMetrics(nextApiMetrics); setProductMetrics(nextProductMetrics); setFeatures(nextFeatures.features); setAuthenticated(true); setNotice('');
    } catch (error) {
      setAuthenticated(false);
      setNotice(error instanceof Error && error.message === '503' ? '게임 서버 메트릭 연결이 아직 설정되지 않았습니다.' : '관리자 세션이 필요하거나 만료되었습니다.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiBase()}/v1/admin/session`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, totp: totp || undefined }) });
    setSecret(''); setTotp('');
    if (!response.ok) { setNotice('관리자 인증 또는 MFA 코드가 올바르지 않습니다.'); return; }
    setAuthenticated(true); await refresh();
  };
  const logout = async () => { await fetch(`${apiBase()}/v1/admin/session`, { method: 'DELETE', credentials: 'include' }); setAuthenticated(false); setOps(null); setConfig(null); setReports([]); setAudit([]); setAnnouncement(null); setApiMetrics(null); setProductMetrics(null); setFeatures(null); setNotice('로그아웃했습니다.'); };
  const drain = async (roomId?: string) => {
    const target = roomId ? `Room ${roomId}` : '모든 활성 Room';
    if (!window.confirm(`${target}의 신규 매치를 중지하고 drain하시겠습니까? 진행 중인 경기는 유지됩니다.`)) return;
    try {
      await command(roomId ? `/v1/admin/ops/rooms/${encodeURIComponent(roomId)}/drain` : '/v1/admin/ops/drain');
      setNotice(`${target} drain을 요청했습니다.`); await refresh();
    } catch { setNotice('drain 요청에 실패했습니다. 세션과 게임 서버 연결을 확인해 주세요.'); }
  };
  const advanceRollout = async (rolloutPercent: number) => {
    if (!window.confirm(`활성 설정을 ${rolloutPercent}%로 승격하시겠습니까? P1 경보가 있으면 자동으로 중단됩니다.`)) return;
    try {
      await command('/v1/admin/config/rollout', { rolloutPercent });
      setNotice(`설정 롤아웃을 ${rolloutPercent}%로 승격했습니다.`); await refresh();
    } catch (error) { setNotice(error instanceof Error && error.message === '409' ? 'P1 경보 또는 비단조 승격 때문에 롤아웃이 중단되었습니다.' : '롤아웃 승격에 실패했습니다. 운영 메트릭 연결을 확인해 주세요.'); }
  };
  const publishAnnouncement = async () => {
    const message = announcementDraft.trim();
    if (!message) { setNotice('공지 내용을 입력해 주세요.'); return; }
    if (!window.confirm('이 공지를 모든 플레이어에게 게시하시겠습니까?')) return;
    try { await command('/v1/admin/announcements/current', { message }, 'PUT'); setAnnouncementDraft(''); setNotice('공지를 게시했습니다.'); await refresh(); } catch { setNotice('공지 게시에 실패했습니다.'); }
  };
  const clearAnnouncement = async () => {
    if (!window.confirm('현재 공지를 해제하시겠습니까?')) return;
    try { await command('/v1/admin/announcements/current', undefined, 'DELETE'); setNotice('공지를 해제했습니다.'); await refresh(); } catch { setNotice('공지 해제에 실패했습니다.'); }
  };
  const scheduleEvent = async () => {
    const id = eventId.trim(); const title = eventTitle.trim(); const theme = eventTheme.trim();
    if (!id || !title || !theme || !eventStartsAt || !eventEndsAt) { setNotice('이벤트 ID·제목·테마·시작/종료 시간을 모두 입력해 주세요.'); return; }
    const targetRegions = eventRegions.split(',').map((region) => region.trim()).filter(Boolean);
    if (!window.confirm(`이벤트 ${id}을(를) ${targetRegions.length ? targetRegions.join(', ') : '모든 지역'}에 예약하시겠습니까?`)) return;
    try {
      await command(`/v1/admin/events/${encodeURIComponent(id)}`, { title, theme, startsAt: new Date(eventStartsAt).toISOString(), endsAt: new Date(eventEndsAt).toISOString(), targetRegions }, 'PUT');
      setEventId(''); setEventTitle(''); setEventTheme(''); setEventStartsAt(''); setEventEndsAt(''); setEventRegions(''); setNotice('테마 이벤트를 예약했습니다.'); await refresh();
    } catch { setNotice('이벤트 예약에 실패했습니다. ID·시간·대상 지역을 확인해 주세요.'); }
  };
  const banFromReport = async (report: Report) => {
    if (!report.targetUserId) return;
    if (!window.confirm(`${report.targetUserId} 계정을 신고 사유로 24시간 제재하시겠습니까?`)) return;
    try { await command(`/v1/admin/users/${encodeURIComponent(report.targetUserId)}/ban`, { until: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), reason: `report:${report.reason}` }); setNotice('24시간 제재를 적용했습니다.'); await refresh(); } catch { setNotice('제재 요청에 실패했습니다.'); }
  };
  const toggleFeature = async (name: keyof Features) => {
    if (!features) return;
    const next = { ...features, [name]: !features[name] };
    if (!window.confirm(`${name} 기능을 ${next[name] ? '활성화' : '비활성화'}하시겠습니까?`)) return;
    try { await command('/v1/admin/features', { features: next }, 'PUT'); setFeatures(next); setNotice(`${name} 기능을 ${next[name] ? '활성화' : '비활성화'}했습니다.`); } catch { setNotice('기능 플래그 변경에 실패했습니다.'); }
  };

  if (!authenticated) return <main style={{ ...shell, display: 'grid', placeItems: 'center' }} data-testid="admin-login"><form onSubmit={login} style={{ ...card, width: 'min(420px, 100%)' }}>
    <h1 style={{ marginTop: 0, color: '#6fd79a' }}>SERPENT 운영 콘솔</h1>
    <p style={{ color: '#8aa0b8', fontSize: 13 }}>비밀은 저장되지 않으며 15분 HttpOnly 세션만 발급됩니다.</p>
    <label style={{ display: 'block', marginTop: 12 }}>관리자 비밀<input aria-label="관리자 비밀" required type="password" value={secret} onChange={(e) => setSecret(e.target.value)} style={input} /></label>
    <label style={{ display: 'block', marginTop: 12 }}>TOTP (운영 환경 필수)<input aria-label="TOTP" inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} style={input} /></label>
    {notice && <p role="alert" style={{ color: '#e87f8e' }}>{notice}</p>}<button type="submit" style={{ ...action, marginTop: 16 }}>안전하게 로그인</button>
  </form></main>;

  return <main style={shell} data-testid="admin-console">
    <header style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}><div><h1 style={{ margin: 0, color: '#6fd79a', fontSize: 24 }}>SERPENT 운영 콘솔</h1><span style={{ color: '#8aa0b8', fontSize: 12 }}>Room 상태 · 설정 버전 · 신고 검토 · 감사 로그</span></div><div style={{ display: 'flex', gap: 8 }}><button style={action} onClick={() => void drain()}>전체 drain</button><button style={action} onClick={() => void refresh()}>새로고침</button><button style={action} onClick={() => void logout()}>로그아웃</button></div></header>
    {notice && <p role="alert" style={{ color: '#e8b56b' }}>{notice}</p>}
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
      <Metric label="활성 Room" value={ops?.activeRooms ?? '-'} /><Metric label="인간 플레이어" value={ops?.humans ?? '-'} /><Metric label="봇" value={ops?.bots ?? '-'} /><Metric label="활성 설정" value={config?.active.version ?? '-'} />
    </section>
    <section style={{ ...card, marginTop: 12, borderColor: ops?.alerts.length ? '#e8b56b' : '#2a3a44' }} aria-live="polite"><h2 style={heading}>활성 경보</h2>{ops?.alerts.length ? ops.alerts.map((alert, index) => <div key={`${alert.code}:${alert.roomId ?? index}`} style={{ ...row, color: alert.severity === 'P1' ? '#e87f8e' : alert.severity === 'P2' ? '#e8b56b' : '#d8e6dd' }}><strong>{alert.severity}</strong> · {alert.roomId ? `${alert.roomId} · ` : ''}{alert.message}</div>) : <span style={{ color: '#6fd79a', fontSize: 13 }}>활성 경보 없음</span>}</section>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginTop: 12 }}>
      <div style={card}><h2 style={heading}>Room 상태</h2>{ops?.rooms.length ? <table style={table}><thead><tr><th>Room</th><th>인원</th><th>RTT</th><th>Tick P99</th><th>AOI P95</th><th>Snapshot P95</th><th>전송량</th><th>오류</th><th>제어</th></tr></thead><tbody>{ops.rooms.map((room) => <tr key={room.roomId}><td>{room.roomId}</td><td>{room.humans}+{room.bots}</td><td>{room.averageRttMs?.toFixed(0) ?? '-'}ms</td><td>{room.tickP99Ms.toFixed(1)}ms</td><td>{room.aoiEntitiesP95}</td><td>{formatBytes(room.snapshotP95Bytes)}</td><td>{formatBytes(room.outboundBytesPerSecond)}/s</td><td>{(room.errorRate * 100).toFixed(2)}%{room.draining ? ' · drain' : ''}</td><td><button type="button" disabled={room.draining} style={{ ...action, minHeight: 28, padding: '3px 6px', opacity: room.draining ? 0.5 : 1 }} onClick={() => void drain(room.roomId)}>drain</button></td></tr>)}</tbody></table> : <p style={{ color: '#8aa0b8' }}>활성 Room이 없습니다.</p>}</div>
      <div style={card}><h2 style={heading}>API 상태 (최근 60초)</h2><p>요청 {apiMetrics?.requests ?? '-'} · RPS {apiMetrics?.requestsPerSecond.toFixed(2) ?? '-'}</p><p>P50 {apiMetrics?.latencyP50Ms.toFixed(1) ?? '-'}ms · P95 {apiMetrics?.latencyP95Ms.toFixed(1) ?? '-'}ms</p><p>5xx {apiMetrics?.errors5xx ?? '-'} · 오류율 {apiMetrics ? `${(apiMetrics.errorRate * 100).toFixed(2)}%` : '-'}</p><p>DB pool {apiMetrics?.databasePool ? `${apiMetrics.databasePool.total - apiMetrics.databasePool.idle}/${apiMetrics.databasePool.total} 활성 · 대기 ${apiMetrics.databasePool.waiting} · 포화 ${(apiMetrics.databasePool.saturation * 100).toFixed(0)}%` : '메모리 저장소'}</p></div>
      <div style={card}><h2 style={heading}>게임 서버 프로세스</h2><p>RSS {ops?.process ? formatBytes(ops.process.rssBytes) : '-'} · Heap {ops?.process ? formatBytes(ops.process.heapUsedBytes) : '-'}</p><p>Event loop P99 {ops?.process ? `${ops.process.eventLoopLagP99Ms.toFixed(1)}ms` : '-'}{ops?.process?.draining ? ' · 드레이닝' : ''}</p></div>
      <div style={card}><h2 style={heading}>제품 퍼널 (최근 24시간)</h2><p>완료 경기 {productMetrics?.matches.completed ?? '-'} · 플레이어 {productMetrics?.matches.uniquePlayers ?? '-'} · 평균 생존 {productMetrics ? `${(productMetrics.matches.averageSurvivalMs / 1000).toFixed(1)}초` : '-'}</p><p>D1 {productMetrics ? `${(productMetrics.retention.d1.rate * 100).toFixed(1)}% (${productMetrics.retention.d1.retained}/${productMetrics.retention.d1.cohort})` : '-'} · D7 {productMetrics ? `${(productMetrics.retention.d7.rate * 100).toFixed(1)}% (${productMetrics.retention.d7.retained}/${productMetrics.retention.d7.cohort})` : '-'}</p>{productMetrics?.funnel.length ? productMetrics.funnel.map((item) => <div key={item.name} style={row}>{item.name} · 이벤트 {item.events} · 사용자 {item.uniqueUsers}</div>) : <p style={{ color: '#8aa0b8' }}>수집된 퍼널 이벤트가 없습니다.</p>}</div>
      <div style={card}><h2 style={heading}>Feature flags</h2>{features ? (Object.entries(features) as [keyof Features, boolean][]).map(([name, enabled]) => <div key={name} style={row}><span>{name} · {enabled ? '활성' : '비활성'}</span><button type="button" style={{ ...action, minHeight: 28, padding: '3px 6px', marginLeft: 8 }} onClick={() => void toggleFeature(name)}>{enabled ? '끄기' : '켜기'}</button></div>) : <p style={{ color: '#8aa0b8' }}>불러오는 중…</p>}</div>
      <div style={card}><h2 style={heading}>설정 롤아웃</h2><p>활성 {config?.active.version ?? '-'} · {config?.active.rolloutPercent ?? '-'}%</p><div style={{ display: 'flex', gap: 6 }}>{[10, 50, 100].filter((percent) => percent > (config?.active.rolloutPercent ?? 100)).map((percent) => <button type="button" key={percent} style={{ ...action, minHeight: 30, padding: '4px 8px' }} onClick={() => void advanceRollout(percent)}>{percent}% 승격</button>)}</div><ul style={{ paddingLeft: 18 }}>{config?.history.slice().reverse().slice(0, 6).map((revision) => <li key={`${revision.version}:${revision.activatedAt}`}>{revision.version} · {revision.rolloutPercent}% · {new Date(revision.activatedAt).toLocaleString()}</li>)}</ul></div>
      <div style={card}><h2 style={heading}>공지</h2>{announcement && <p style={{ color: '#8aa0b8', fontSize: 13 }}>현재: {announcement.message}</p>}<textarea aria-label="공지 내용" value={announcementDraft} onChange={(event) => setAnnouncementDraft(event.target.value)} maxLength={280} placeholder="점검·이벤트 안내 (최대 280자)" style={{ ...input, minHeight: 72, resize: 'vertical' }} /><div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button type="button" style={action} onClick={() => void publishAnnouncement()}>게시</button>{announcement && <button type="button" style={action} onClick={() => void clearAnnouncement()}>해제</button>}</div></div>
      <div style={card}><h2 style={heading}>테마 이벤트 예약</h2><input aria-label="이벤트 ID" value={eventId} onChange={(event) => setEventId(event.target.value)} maxLength={64} placeholder="summer-2026" style={input} /><input aria-label="이벤트 제목" value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} maxLength={80} placeholder="이벤트 제목" style={input} /><input aria-label="이벤트 테마" value={eventTheme} onChange={(event) => setEventTheme(event.target.value)} maxLength={40} placeholder="테마" style={input} /><label style={{ display: 'block', marginTop: 8, fontSize: 12 }}>시작<input aria-label="이벤트 시작" type="datetime-local" value={eventStartsAt} onChange={(event) => setEventStartsAt(event.target.value)} style={input} /></label><label style={{ display: 'block', marginTop: 8, fontSize: 12 }}>종료<input aria-label="이벤트 종료" type="datetime-local" value={eventEndsAt} onChange={(event) => setEventEndsAt(event.target.value)} style={input} /></label><input aria-label="이벤트 대상 지역" value={eventRegions} onChange={(event) => setEventRegions(event.target.value)} placeholder="kr-seoul, jp-tokyo (비우면 전체)" style={input} /><button type="button" style={{ ...action, marginTop: 8 }} onClick={() => void scheduleEvent()}>예약</button></div>
      <div style={card}><h2 style={heading}>최근 신고</h2>{reports.length ? reports.map((report) => <div key={report.id} style={row}><strong>{report.reason}</strong> · 대상 {report.targetUserId ?? '없음'}<br /><span style={{ color: '#8aa0b8' }}>{report.detail ?? '세부 내용 없음'}</span>{report.targetUserId && <button type="button" style={{ ...action, minHeight: 28, padding: '3px 6px', marginTop: 6 }} onClick={() => void banFromReport(report)}>24시간 제재</button>}</div>) : <p style={{ color: '#8aa0b8' }}>검토 대기 신고가 없습니다.</p>}</div>
      <div style={card}><h2 style={heading}>감사 로그</h2>{audit.map((entry) => <div key={entry.id} style={row}>{entry.action} · {entry.target}<br /><span style={{ color: '#8aa0b8' }}>{new Date(entry.createdAt).toLocaleString()}</span></div>)}</div>
    </section>
  </main>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div style={card}><div style={{ color: '#8aa0b8', fontSize: 12 }}>{label}</div><strong style={{ color: '#6fd79a', fontSize: 22 }}>{value}</strong></div>; }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${Math.round(bytes)}B` : `${(bytes / 1024).toFixed(1)}KB`; }
const input: React.CSSProperties = { display: 'block', boxSizing: 'border-box', width: '100%', marginTop: 6, minHeight: 40, background: '#101418', color: '#d8e6dd', border: '1px solid #2a3a44', borderRadius: 6, padding: 8, fontFamily: 'monospace' };
const heading: React.CSSProperties = { marginTop: 0, color: '#6fd79a', fontSize: 16 };
const table: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
const row: React.CSSProperties = { borderTop: '1px solid #2a3a44', padding: '8px 0', fontSize: 12 };
