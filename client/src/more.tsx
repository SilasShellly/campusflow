import { useEffect, useState, FormEvent } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGrid from '@fullcalendar/daygrid';
import timeGrid from '@fullcalendar/timegrid';
import { api } from './api';

const fmt = (d: string) => new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const form = (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; };

export function AuthFlow({ onDone }: { onDone: (u: any) => void }) {
  const tok = new URLSearchParams(location.search).get('reset');
  const [mode, setMode] = useState(tok ? 'reset' : 'login'); const [msg, setMsg] = useState(''); const [pending, setPending] = useState<any>(null);
  const run = async (path: string, body: object, after: (r: any) => void) => { try { after(await api(path, { method: 'POST', body })); } catch (e) { setMsg((e as Error).message); } };
  const sendOtp = async (identity: string) => {
    const value = identity.trim();
    if (!value) return setMsg('Enter your campus email or ID to receive the code.');
    await run('/auth/send-otp', { identifier: value }, () => setMsg('A one-time verification code was sent to your email.'));
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const f = form(e); setMsg('');
    if (mode === 'login') run('/auth/login', { identifier: f.identifier, password: f.password, otp: f.otp }, r => { const u = { ...r, fullName: r.name }; if (r.mustChangePassword) { setPending(u); setMode('change'); } else onDone(u); });
    else if (mode === 'forgot') run('/auth/forgot-password', f, () => setMsg('If that account exists, a reset link has been emailed.'));
    else if (mode === 'reset') run('/auth/reset-password', { token: tok, password: f.password }, () => { history.replaceState(null, '', '/'); setMode('login'); setMsg('Password updated. Please sign in.'); });
    else run('/auth/change-password', f, () => onDone(pending));
  };
  const L = ({ n, t, a, type = 'text' }: { n: string; t: string; a?: string; type?: string }) => <label>{t}<input name={n} type={type} required autoComplete={a} minLength={n === 'email' ? undefined : 1} /></label>;
  return (<div className="login"><aside><h1>CampusFlow</h1><p className="tag">One campus.<br />Every resource.<br />One intelligent booking system.</p></aside>
    <main><form onSubmit={submit} aria-label={mode}><h2>{{ login: 'Welcome back', forgot: 'Forgot password', reset: 'Choose a new password', change: 'Set your new password' }[mode]}</h2>
      {(mode === 'login' || mode === 'forgot') && <L n="identifier" t="College Email or Student/Faculty ID" a="username" />}
      {mode === 'login' && <L n="password" t="Password" a="current-password" type="password" />}
      {mode === 'login' && <div className="card" style={{ marginBottom: 12 }}><label>OTP code (if email verification is required)<input name="otp" placeholder="6-digit code" inputMode="numeric" maxLength={6} /></label><button type="button" onClick={(e) => { e.preventDefault(); const formEl = (e.currentTarget as HTMLButtonElement).form; const idValue = new FormData(formEl!).get('identifier')?.toString() ?? ''; void sendOtp(idValue); }}>Send OTP</button></div>}
      {mode === 'change' && <L n="current" t="Temporary password" a="current-password" type="password" />}
      {(mode === 'reset' || mode === 'change') && <L n="password" t="New password (8+ characters)" a="new-password" type="password" />}
      {msg && <p className={msg.startsWith('If') || msg.startsWith('Password') || msg.includes('sent') ? '' : 'err'} role="alert">{msg}</p>}
      <button className="primary">{mode === 'login' ? 'Sign In' : 'Continue'}</button>
      {mode === 'login' && <button type="button" onClick={() => setMode('forgot')}>Forgot password?</button>}
      {mode === 'forgot' && <button type="button" onClick={() => setMode('login')}>Back to sign in</button>}</form></main></div>);
}

const STUDENT_BODIES = ['St Council', 'Tedx', 'IET', 'NSS'];
const DEPARTMENTS = ['Comp', 'IT', 'EXTC', 'CSE'];

export function Users({ say }: { say: (m: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [affiliationType, setAffiliationType] = useState<'STUDENT_BODY' | 'DEPARTMENT'>('STUDENT_BODY');
  const [affiliationName, setAffiliationName] = useState('St Council');
  const load = () => api('/users').then(setRows); useEffect(() => { load(); }, []);
  const add = async (e: FormEvent<HTMLFormElement>) => { const f = form(e), el = e.currentTarget;
    try { await api('/users', { method: 'POST', body: { ...f, institutionId: f.institutionId || f.studentId || undefined, studentId: f.studentId || f.institutionId || undefined, affiliationType, affiliationName } }); say('✓ User created'); el.reset(); setAffiliationType('STUDENT_BODY'); setAffiliationName('St Council'); load(); } catch (x) { say('⚠ ' + (x as Error).message); } };
  const toggle = async (u: any) => { try { await api('/users/' + u.id, { method: 'PUT', body: { disabled: !u.disabled } }); load(); } catch (x) { say('⚠ ' + (x as Error).message); } };
  return (<><h2>Users</h2><form onSubmit={add} className="card" aria-label="Add user"><h3>Add User</h3>
    <label>Full name<input name="fullName" required /></label><label>College email<input name="email" type="email" required /></label>
    <label>Student / Faculty ID<input name="studentId" placeholder="STU-1001 or FAC-204" /></label>
      <label>Affiliation type<select name="affiliationType" value={affiliationType} onChange={(e) => { const type = e.target.value as 'STUDENT_BODY' | 'DEPARTMENT'; setAffiliationType(type); setAffiliationName(type === 'STUDENT_BODY' ? STUDENT_BODIES[0] : DEPARTMENTS[0]); }}><option value="STUDENT_BODY">Student Body</option><option value="DEPARTMENT">Department</option></select></label>
      <label>Affiliation name<select name="affiliationName" value={affiliationName} onChange={e => setAffiliationName(e.target.value)}>{(affiliationType === 'STUDENT_BODY' ? STUDENT_BODIES : DEPARTMENTS).map(v => <option key={v} value={v}>{v}</option>)}</select></label>
    <label>Department<input name="department" placeholder="Comp / IT / EXTC / CSE" list="dept-list" /><datalist id="dept-list">{DEPARTMENTS.map(v => <option key={v} value={v} />)}</datalist></label><label>Phone<input name="phone" /></label>
    <label>Role<select name="role" defaultValue="STUDENT"><option>STUDENT</option><option>FACULTY</option><option>RESOURCE_MANAGER</option><option>ADMIN</option></select></label>
    <label>Temporary password<input name="tempPassword" type="text" minLength={8} required /></label><button className="primary">Create user</button></form>
    {!rows ? <div className="skeleton" style={{ height: 120 }} /> : rows.map(u => <div key={u.id} className="card row"><div><strong>{u.fullName}</strong> · {u.role}<br />{u.email}{u.disabled && <em> · disabled</em>}<br /><small>{u.affiliationName ? (u.affiliationName + ' · ' + (u.affiliationType || 'STUDENT_BODY')) : (u.department ? u.department : 'No affiliation')}</small></div>
      <button onClick={() => toggle(u)}>{u.disabled ? 'Enable' : 'Disable'}</button></div>)}</>);
}

const COLOR: Record<string, string> = { APPROVED: '#16a34a', PENDING: '#ca8a04', REJECTED: '#9ca3af', CANCELLED: '#9ca3af', COMPLETED: '#4338ca' };
export function CalendarView() {
  const [ev, setEv] = useState<any[]>([]); const [sel, setSel] = useState<any>(null);
  useEffect(() => { api('/bookings').then((r: any[]) => setEv(r.map(b => ({ id: b.id, title: `${b.resource.name} · ${b.title}`, start: b.startTime, end: b.endTime, color: COLOR[b.status], extendedProps: b })))); }, []);
  return (<><h2>Calendar</h2><FullCalendar plugins={[dayGrid, timeGrid]} initialView="timeGridWeek" height="auto" events={ev}
    headerToolbar={{ left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' }} eventClick={i => setSel(i.event.extendedProps)} />
    {sel && <aside className="card" style={{ marginTop: 12 }} role="dialog" aria-label="Booking details"><button className="x" onClick={() => setSel(null)} aria-label="Close">×</button>
      <h3>{sel.title}</h3><p>{sel.resource.name}<br />{fmt(sel.startTime)} – {fmt(sel.endTime)}<br />Status: {sel.status}</p></aside>}</>);
}

export function Maintenance({ say }: { say: (m: string) => void }) {
  const [res, setRes] = useState<any[]>([]); useEffect(() => { api('/resources').then(setRes); }, []);
  const go = async (e: FormEvent<HTMLFormElement>) => { const f = form(e);
    try { await api(`/resources/${f.resourceId}/block`, { method: 'POST', body: { start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(), reason: f.reason } }); say('🔧 Resource blocked'); }
    catch (x) { say('⚠ ' + (x as Error).message); } };
  return (<><h2>Block a Resource</h2><form onSubmit={go} className="card" style={{ maxWidth: 420 }} aria-label="Maintenance">
    <label>Resource<select name="resourceId" required>{res.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    <label>From<input name="start" type="datetime-local" required /></label><label>To<input name="end" type="datetime-local" required /></label>
    <label>Reason<input name="reason" required minLength={3} /></label><button className="primary">Block resource</button></form></>);
}

export function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(1, ...data.flat()), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (<div style={{ overflowX: 'auto' }}><h3>Demand heatmap</h3>{[1, 2, 3, 4, 5, 6, 0].map(d => <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 2 }}>
    <span style={{ width: 34, fontSize: 12 }}>{days[d]}</span>{Array.from({ length: 12 }, (_, i) => i + 9).map(h =>
      <span key={h} title={`${days[d]} ${h}:00 · ${data[d][h]}`} style={{ width: 22, height: 18, borderRadius: 3, background: `rgba(67,56,202,${0.08 + (data[d][h] / max) * 0.92})` }} />)}</div>)}
    <small>9 AM → 8 PM</small></div>);
}

export function Priorities({ say }: { say: (m: string) => void }) {
  const roles = ['ADMIN', 'RESOURCE_MANAGER', 'FACULTY', 'STUDENT']; const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => { api('/priorities').then((r: any[]) => setMap(Object.fromEntries(r.map(x => [x.role, x.priority])))); }, []);
  const set = async (role: string, priority: string) => { try { await api('/priorities/' + role, { method: 'PUT', body: { priority } }); setMap({ ...map, [role]: priority }); say('✓ Priority updated'); } catch (x) { say('⚠ ' + (x as Error).message); } };
  return (<><h2>Settings</h2><h3>Booking priority by role</h3><p>New bookings inherit the priority of the requester's role. Priority never silently removes an approved booking: only an admin override can, with a reason.</p>
    {roles.map(r => <label key={r} className="card" style={{ maxWidth: 360 }}>{r.replace('_', ' ')}<select value={map[r] ?? 'NORMAL'} onChange={e => set(r, e.target.value)}>
      {['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map(p => <option key={p}>{p}</option>)}</select></label>)}</>);
}
