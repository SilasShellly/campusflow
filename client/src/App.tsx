import { useEffect, useState, FormEvent } from 'react';
import { api, ApiError } from './api';
import { AuthFlow, Users, CalendarView, Maintenance, Priorities } from './more';
import { QrModal, Notifications, Verify, Insights, Audit } from './extras';

type User = { id: string; fullName: string; role: string };
type Resource = { id: string; name: string; type: string; building: string; floor: number; capacity: number; facilities: string[]; availability: string };
const fmt = (d: string) => new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const toIso = (v: string) => new Date(v).toISOString();

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => { api('/me').then(setUser).catch(() => {}).finally(() => setReady(true)); }, []);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500); };
  if (!ready) return <div className="skeleton" style={{ height: '100vh' }} aria-busy="true" />;
  return (<>
    {user ? <Shell user={user} say={say} onLogout={async () => { await api('/auth/logout', { method: 'POST' }); setUser(null); }} /> : <AuthFlow onDone={setUser} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </>);
}

function Login({ onDone }: { onDone: (u: User) => void }) {
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const identifier = String(f.get('identifier') ?? '').trim();
    const email = String(f.get('email') ?? '').trim();
    try { const u = await api('/auth/login', { method: 'POST', body: { identifier: identifier || email || undefined, password: f.get('password') } }); onDone({ ...u, fullName: u.name }); }
    catch (x) { setErr((x as Error).message); }
  };
  return (<div className="login">
    <aside><h1>CampusFlow</h1><p className="tag">One campus.<br />Every resource.<br />One intelligent booking system.</p></aside>
    <main><form onSubmit={submit} aria-label="Sign in"><h2>Welcome back</h2>
      <label>College Email or Student/Faculty ID<input name="identifier" type="text" placeholder="email@campus.edu or STU-1001" required autoComplete="username" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      {err && <p className="err" role="alert">{err}</p>}
      <button className="primary">Sign In</button></form></main></div>);
}

function Shell({ user, say, onLogout }: { user: User; say: (m: string) => void; onLogout: () => void }) {
  const manager = user.role === 'ADMIN' || user.role === 'RESOURCE_MANAGER';
  const [tab, setTab] = useState('resources');
  const [unread, setUnread] = useState(0);
  useEffect(() => { const f = () => api('/notifications').then((n: any[]) => setUnread(n.filter(x => !x.readAt).length)).catch(() => {}); f(); const i = setInterval(f, 15000); return () => clearInterval(i); }, [tab]);
  const tabs = [['resources', 'Resources'], ['calendar', 'Calendar'], ['mine', 'My Bookings'], ['notifs', 'Notifications' + (unread ? ` (${unread})` : '')], ...(manager ? [['requests', 'Requests'], ['maint', 'Maintenance'], ['verify', 'Verify QR'], ['insights', 'Analytics']] : []), ...(user.role === 'ADMIN' ? [['users', 'Users'], ['settings', 'Settings'], ['audit', 'Audit Logs']] : [])];
  return (<div className="shell">
    <nav aria-label="Main"><strong>CAMPUSFLOW</strong>
      {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-current={tab === k}>{l}</button>)}
      <div className="who">{user.fullName}<small>{user.role.replace('_', ' ')}</small><button onClick={onLogout}>Logout</button></div></nav>
    <main>{tab === 'resources' ? <Explorer say={say} admin={user.role === 'ADMIN'} /> : tab === 'notifs' ? <Notifications /> : tab === 'verify' ? <Verify /> : tab === 'insights' ? <Insights /> : tab === 'audit' ? <Audit /> : tab === 'settings' ? <Priorities say={say} /> : tab === 'users' ? <Users say={say} /> : tab === 'calendar' ? <CalendarView /> : tab === 'maint' ? <Maintenance say={say} /> : <Bookings manager={manager && tab === 'requests'} say={say} />}</main></div>);
}

function Explorer({ say, admin }: { say: (m: string) => void; admin: boolean }) {
  const [rows, setRows] = useState<Resource[] | null>(null);
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<Resource | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => { setRows(null); setNote(''); api('/resources?search=' + encodeURIComponent(search)).then(setRows); }, [search]);
  const smart = async () => {
    setRows(null); const r = await api('/resources/smart-search', { method: 'POST', body: { query: search } }).catch((x: Error) => { say('⚠ ' + x.message); return null; });
    if (!r) return setRows([]); setNote(r.summary); setRows(r.results);
  };
  return (<><h2>Find a Campus Resource</h2>
    <input className="search" placeholder="Search rooms, labs, halls..." aria-label="Search resources" value={search} onChange={e => setSearch(e.target.value)} /> <button onClick={smart} disabled={search.length < 3}>✨ Smart match</button>
    {note && <p>{note}</p>}
    <div className="grid">{rows === null ? [1, 2, 3, 4].map(i => <div key={i} className="card skeleton" style={{ height: 150 }} />) :
      rows.length === 0 ? <p>No resources match your search.</p> :
      rows.map(r => <article key={r.id} className="card"><h3>{r.name}</h3><p>{r.building} · Floor {r.floor}</p><p>Capacity: {r.capacity}</p>
        <p className="chips">{r.facilities.map(f => <span key={f}>{f}</span>)}</p>
        <p><span className={'dot ' + r.availability}>●</span> {r.availability}</p>
        <button className="primary" onClick={() => setPick(r)}>Book</button></article>)}</div>
    {pick && <BookModal r={pick} onClose={() => setPick(null)} say={say} admin={admin} />}</>);
}

function BookModal({ r, onClose, say, admin }: { r: Resource; onClose: () => void; say: (m: string) => void; admin: boolean }) {
  const [conflict, setConflict] = useState<any>(null);
  const [risk, setRisk] = useState<any>(null);
  const [err, setErr] = useState('');
  const check = (e: FormEvent<HTMLFormElement>) => {
    const f = new FormData(e.currentTarget), s = String(f.get('start')), en = String(f.get('end'));
    if (s && en && new Date(en) > new Date(s)) api(`/resources/${r.id}/risk?start=${encodeURIComponent(toIso(s))}&end=${encodeURIComponent(toIso(en))}`).then(setRisk).catch(() => {});
  };
  const wait = async () => {
    try { await api('/waitlist', { method: 'POST', body: { resourceId: r.id, start: conflict.requested.start, end: conflict.requested.end, ...conflict.form } }); say('✓ Added to waitlist. We will notify you if it frees up.'); onClose(); }
    catch (x) { say('⚠ ' + (x as Error).message); }
  };
  const override = async () => {
    const body = { resourceId: r.id, start: conflict.requested.start, end: conflict.requested.end, ...conflict.form };
    try { await api('/bookings/override', { method: 'POST', body }); }
    catch (x) {
      const aff = (x as ApiError).body?.affected ?? [];
      if (!aff.length) return say('⚠ ' + (x as Error).message);
      if (!confirm('This will cancel: ' + aff.map((a: any) => a.title).join(', ') + '. Their owners will be notified. Continue?')) return;
      const reason = prompt('Reason for override (required)'); if (!reason) return;
      try { await api('/bookings/override', { method: 'POST', body: { ...body, reason, confirm: true } }); say('✓ Override applied; affected users notified'); onClose(); }
      catch (y) { say('⚠ ' + (y as Error).message); }
    }
  };
  const send = async (resourceId: string, start: string, end: string, f: { title: string; attendees: number }) => {
    try { await api('/bookings', { method: 'POST', body: { resourceId, start, end, ...f } }); say('✓ Booking request submitted'); onClose(); }
    catch (x) { if (x instanceof ApiError && x.status === 409) { setConflict({ ...x.body, form: f }); setErr(''); } else setErr((x as Error).message); }
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    send(r.id, toIso(String(f.get('start'))), toIso(String(f.get('end'))), { title: String(f.get('title')), attendees: Number(f.get('attendees')) });
  };
  return (<div className="modal" role="dialog" aria-modal="true" aria-label={'Book ' + r.name}><div className="sheet">
    <button className="x" onClick={onClose} aria-label="Close">×</button>
    {!conflict ? (<form onSubmit={submit} onChange={check}><h2>Book {r.name}</h2>
      <label>Event name<input name="title" required minLength={2} /></label>
      <label>Attendees<input name="attendees" type="number" min={1} max={r.capacity} required /></label>
      <label>Start<input name="start" type="datetime-local" required /></label>
      <label>End<input name="end" type="datetime-local" required /></label>
      {err && <p className="err" role="alert">{err}</p>}{risk && risk.level !== 'LOW' && <p className="err" role="status">⚠ {risk.level === 'HIGH' ? 'High' : 'Moderate'} likelihood of conflict: this slot was taken in {risk.pct}% of the last {risk.weeks} weeks.</p>}
      <button className="primary">Request Booking</button></form>) : (
      <div><h2>Booking Conflict Detected</h2>
        <p><strong>{conflict.requested.resource.name}</strong> · {fmt(conflict.requested.start)} – {fmt(conflict.requested.end)}</p>
        {conflict.conflicts.map((c: any) => <p key={c.id} className="err">Existing: {c.title} · {fmt(c.start)} – {fmt(c.end)}</p>)}
        <h3>Recommended Alternatives</h3>
        {conflict.alternatives.length === 0 && <p>No alternatives found nearby. Try another day.</p>}
        {conflict.alternatives.map((a: any, i: number) => <div key={i} className="card"><strong>{a.resource.name}</strong>
          <p>{fmt(a.start)} – {fmt(a.end)} · Capacity {a.resource.capacity}</p>
          <ul>{a.reasons.map((x: string) => <li key={x}>✓ {x}</li>)}</ul>
          <button className="primary" onClick={() => send(a.resource.id, a.start, a.end, conflict.form)}>Use This Option</button></div>)}
        <button onClick={wait}>Join Waitlist</button>{admin && <button onClick={override}>Admin override…</button>}
      </div>)}</div></div>);
}

function Bookings({ manager, say }: { manager: boolean; say: (m: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const load = () => api('/bookings').then(setRows);
  useEffect(() => { load(); }, []);
  const act = async (id: string, what: string, body?: object, msg = '') => {
    try { await api(`/bookings/${id}/${what}`, { method: 'POST', body: body ?? {} }); say(msg); load(); } catch (x) { say('⚠ ' + (x as Error).message); load(); }
  };
  const list = rows?.filter(b => !manager || b.status === 'PENDING');
  if (!list) return <div className="skeleton" style={{ height: 200 }} />;
  if (!list.length) return <div><h2>{manager ? 'No pending requests' : 'No Upcoming Bookings'}</h2><p>{manager ? 'You are all caught up.' : "You don't have any reservations yet."}</p></div>;
  return (<><h2>{manager ? 'Pending Requests' : 'My Bookings'}</h2>{qr && <QrModal id={qr} onClose={() => setQr(null)} />}{list.map(b => <div key={b.id} className="card row">
    <div><strong>{b.title}</strong> · {b.resource.name}<br />{fmt(b.startTime)} – {fmt(b.endTime)} · <em>{b.status}</em>{manager && <> · {b.requester.fullName} · {b.priority}</>}</div>
    <div>{manager && b.status === 'PENDING' && <>
      <button className="primary" onClick={() => act(b.id, 'approve', {}, '✓ Booking approved')}>Approve</button>
      <button onClick={() => { const reason = prompt('Reason for rejection?'); if (reason) act(b.id, 'reject', { reason }, '✕ Booking rejected'); }}>Reject</button></>}
      {b.status === 'APPROVED' && !manager && <button onClick={() => setQr(b.id)}>QR Pass</button>}
      {['PENDING', 'APPROVED'].includes(b.status) && !manager && <button onClick={() => act(b.id, 'cancel', {}, '✕ Booking cancelled')}>Cancel</button>}</div></div>)}</>);
}
