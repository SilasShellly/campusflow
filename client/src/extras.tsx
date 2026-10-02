import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import { api } from './api';
import { Heatmap } from './more';

const fmt = (d: string) => new Date(d).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function QrModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [img, setImg] = useState(''); const [code, setCode] = useState('');
  useEffect(() => { api(`/bookings/${id}/qr`, { method: 'POST' }).then(async r => { setCode(r.code); setImg(await QRCode.toDataURL(r.token, { width: 260 })); }); }, [id]);
  return (<div className="modal" role="dialog" aria-modal="true" aria-label="QR pass"><div className="sheet" style={{ textAlign: 'center' }}>
    <button className="x" onClick={onClose} aria-label="Close">×</button><h2>Booking Confirmed ✓</h2><p>{code}</p>
    {img ? <img src={img} alt="Booking QR code" /> : <div className="skeleton" style={{ height: 260 }} />}<p>Show this QR code at the venue.</p></div></div>);
}

export function Notifications() {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => api('/notifications').then(setRows);
  useEffect(() => { load(); }, []);
  if (!rows) return <div className="skeleton" style={{ height: 160 }} />;
  if (!rows.length) return <div><h2>No notifications</h2><p>You're all caught up.</p></div>;
  return (<><h2>Notifications</h2>{rows.map(n => <div key={n.id} className="card row" style={{ opacity: n.readAt ? 0.6 : 1 }}>
    <div><strong>{n.title}</strong><br />{n.body}<br /><small>{fmt(n.createdAt)}</small></div>
    {!n.readAt && <button onClick={async () => { await api(`/notifications/${n.id}/read`, { method: 'POST' }); load(); }}>Mark read</button>}</div>)}</>);
}

export function Verify() {
  const [res, setRes] = useState<any>(null); const [manual, setManual] = useState(''); const scanner = useRef<Html5Qrcode | null>(null);
  const check = async (token: string) => { setRes(await api('/qr/verify', { method: 'POST', body: { token } }).catch(() => ({ valid: false, reason: 'Invalid QR' }))); };
  const scan = async () => {
    scanner.current = new Html5Qrcode('reader');
    await scanner.current.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, async t => { await scanner.current?.stop(); check(t); }, () => {});
  };
  useEffect(() => () => { scanner.current?.isScanning && scanner.current.stop(); }, []);
  return (<><h2>QR Verification</h2><div id="reader" style={{ maxWidth: 360 }} /><button className="primary" onClick={scan}>Scan with camera</button>
    <form onSubmit={e => { e.preventDefault(); check(manual.trim()); }} style={{ maxWidth: 360, marginTop: 12 }}>
      <label>Or paste token<input value={manual} onChange={e => setManual(e.target.value)} /></label><button>Verify</button></form>
    {res && <div className="card" role="status" style={{ marginTop: 16, borderColor: res.valid ? '#16a34a' : '#dc2626' }}>
      {res.valid ? <><h3>✓ VALID BOOKING</h3><p>{res.resource}<br />{res.name}<br />{fmt(res.start)} – {fmt(res.end)}<br />Status: {res.status}</p></>
        : <><h3>✕ INVALID BOOKING</h3><p>Reason: {res.reason}</p></>}</div>}</>);
}

export function Insights() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api('/analytics/dashboard').then(setD); }, []);
  if (!d) return <div className="skeleton" style={{ height: 240 }} />;
  const max = Math.max(1, ...d.peakHours.map((p: any) => p.count));
  return (<><h2>Analytics</h2><div className="grid">{Object.entries(d.kpis).map(([k, v]) => <div key={k} className="card"><small>{k}</small><h3>{String(v)}</h3></div>)}
    <div className="card"><small>Approval rate</small><h3>{d.approvalRate}%</h3></div><div className="card"><small>Cancellation rate</small><h3>{d.cancellationRate}%</h3></div></div>
    <h3>Resource utilization (30 days)</h3>{d.utilization.map((u: any) => <div key={u.name}>{u.name} · {u.pct}%<div style={{ background: '#4338ca', height: 8, width: Math.min(100, u.pct) + '%', borderRadius: 4, marginBottom: 6 }} /></div>)}
    <h3>Peak hours</h3><div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 100 }}>{d.peakHours.map((p: any) =>
      <div key={p.hour} title={`${p.hour}:00 · ${p.count}`} style={{ flex: 1, background: '#818cf8', height: (p.count / max) * 100 + '%', minHeight: 2 }} />)}</div>
    <Heatmap data={d.heatmap} /><h3>Campus Insight</h3>{d.insights.length ? d.insights.map((i: string) => <div key={i} className="card">{i}</div>) : <p>Not enough data yet.</p>}</>);
}

export function Audit() {
  const [rows, setRows] = useState<any[] | null>(null); const [q, setQ] = useState('');
  useEffect(() => { api('/audit-logs?action=' + encodeURIComponent(q)).then(setRows); }, [q]);
  return (<><h2>Audit Logs</h2><input className="search" placeholder="Filter by action, e.g. APPROVED" aria-label="Filter audit logs" value={q} onChange={e => setQ(e.target.value)} />
    {!rows ? <div className="skeleton" style={{ height: 160 }} /> : rows.length === 0 ? <p>No matching events.</p> : rows.map(r => <div key={r.id} className="card">
      <strong>{r.action}</strong> · {r.entity} <small>{fmt(r.at)}</small></div>)}</>);
}
