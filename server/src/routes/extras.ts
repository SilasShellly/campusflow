import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { notify } from '../services/notificationService.js';
import { z } from 'zod';
import { prisma, findConflicts } from '../services/bookingService.js';
import { audit } from '../services/auditService.js';
import { requireAuth, requireRole, AuthedRequest } from './auth.js';

export const extraRouter = Router();
extraRouter.use(requireAuth);
const MANAGE = ['ADMIN', 'RESOURCE_MANAGER'] as const;
const uid = (req: any) => (req as AuthedRequest).user.id;

// --- QR: random token only, no personal data; revocable ---
extraRouter.post('/bookings/:id/qr', async (req, res) => {
  const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!b || (b.requesterId !== uid(req) && (req as AuthedRequest).user.role !== 'ADMIN')) return res.status(404).json({ error: 'Booking not found.' });
  if (b.status !== 'APPROVED') return res.status(409).json({ error: 'QR passes are issued once a booking is approved.' });
  const t = await prisma.bookingToken.findFirst({ where: { bookingId: b.id, revokedAt: null } })
    ?? await prisma.bookingToken.create({ data: { bookingId: b.id, token: randomBytes(24).toString('base64url') } });
  res.json({ token: t.token, code: `CF-${b.startTime.getUTCFullYear()}-${String(b.seq).padStart(5, '0')}` });
});

extraRouter.post('/qr/verify', requireRole(...MANAGE), async (req, res) => {
  const p = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
  const bad = (reason: string) => res.json({ valid: false, reason });
  if (!p.success) return bad('Invalid QR');
  const t = await prisma.bookingToken.findUnique({ where: { token: p.data.token }, include: { booking: { include: { resource: true, requester: { select: { fullName: true } } } } } });
  if (!t) return bad('Invalid QR');
  const b = t.booking, now = Date.now();
  let reason = '';
  if (t.revokedAt) reason = 'QR was revoked';
  else if (b.status === 'CANCELLED') reason = 'Booking cancelled';
  else if (b.status !== 'APPROVED') reason = 'Booking not approved';
  else if (now > b.endTime.getTime()) reason = 'Booking expired';
  else if (now < b.startTime.getTime() - 15 * 60_000) reason = 'Too early: booking has not started';
  await audit(uid(req), reason ? 'QR_REJECTED' : 'QR_VERIFIED', 'Booking', b.id, undefined, { reason });
  if (reason) return bad(reason);
  res.json({ valid: true, resource: b.resource.name, name: b.requester.fullName, start: b.startTime, end: b.endTime, status: b.status });
});

// --- Notifications ---
extraRouter.get('/notifications', async (req, res) =>
  res.json(await prisma.notification.findMany({ where: { userId: uid(req) }, orderBy: { createdAt: 'desc' }, take: 50 })));
extraRouter.post('/notifications/:id/read', async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: uid(req) }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

// --- Maintenance blocks (refuses if approved/pending bookings would be silently clobbered) ---
extraRouter.post('/resources/:id/block', requireRole(...MANAGE), async (req, res) => {
  const p = z.object({ start: z.coerce.date(), end: z.coerce.date(), reason: z.string().min(3) }).safeParse(req.body);
  if (!p.success || p.data.end <= p.data.start) return res.status(400).json({ error: 'Check the dates and reason.' });
  const affected = (await findConflicts(prisma, req.params.id, p.data.start, p.data.end)).filter(c => c.kind === 'BOOKING');
  if (affected.length) return res.status(409).json({ error: 'Existing bookings overlap this period. Resolve them first.', affected });
  const blk = await prisma.resourceBlock.create({ data: { resourceId: req.params.id, startTime: p.data.start, endTime: p.data.end, reason: p.data.reason } });
  await audit(uid(req), 'RESOURCE_BLOCKED', 'Resource', req.params.id, undefined, { start: p.data.start, end: p.data.end, reason: p.data.reason });
  res.status(201).json(blk);
});

// --- Audit (admin) ---
extraRouter.get('/audit-logs', requireRole('ADMIN'), async (req, res) => {
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  res.json(await prisma.auditLog.findMany({ where: { action: action ? { contains: action.toUpperCase() } : undefined }, orderBy: { at: 'desc' }, take: 200 }));
});

// --- Analytics: computed from real bookings ---
extraRouter.get('/analytics/dashboard', requireRole(...MANAGE), async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86_400_000), today = new Date(); today.setHours(0, 0, 0, 0);
  const [bookings, resources, users, todayCount, pending] = await Promise.all([
    prisma.booking.findMany({ where: { startTime: { gte: since } }, include: { resource: true } }),
    prisma.resource.count(), prisma.user.count(),
    prisma.booking.count({ where: { startTime: { gte: today, lt: new Date(today.getTime() + 86_400_000) } } }),
    prisma.booking.count({ where: { status: 'PENDING' } }),
  ]);
  const approved = bookings.filter(b => b.status === 'APPROVED' || b.status === 'COMPLETED');
  const hours: Record<string, number> = {}, peak: number[] = Array(24).fill(0);
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const b of approved) {
    hours[b.resource.name] = (hours[b.resource.name] ?? 0) + (b.endTime.getTime() - b.startTime.getTime()) / 3.6e6;
    peak[b.startTime.getHours()]++; heat[b.startTime.getDay()][b.startTime.getHours()]++;
  }
  const OPEN_HOURS = 30 * 12; // assumed 12h/day opening
  const utilization = Object.entries(hours).map(([name, h]) => ({ name, pct: Math.round((h / OPEN_HOURS) * 100) })).sort((a, b) => b.pct - a.pct);
  const decided = bookings.filter(b => ['APPROVED', 'REJECTED', 'COMPLETED'].includes(b.status)).length;
  const insights = [
    utilization[0] && `${utilization[0].name} is the most utilized resource (${utilization[0].pct}%). Consider opening a similar resource at peak hours.`,
    utilization.length > 1 && `${utilization[utilization.length - 1].name} is underused (${utilization[utilization.length - 1].pct}%).`,
  ].filter(Boolean);
  res.json({
    kpis: { users, resources, today: todayCount, pending },
    utilization, peakHours: peak.map((count, hour) => ({ hour, count })).filter(x => x.hour >= 8 && x.hour <= 20),
    approvalRate: decided ? Math.round((approved.length / decided) * 100) : 0,
    cancellationRate: bookings.length ? Math.round((bookings.filter(b => b.status === 'CANCELLED').length / bookings.length) * 100) : 0,
    insights, heatmap: heat,
  });
});

// --- User administration (admin only) ---
const userSel = { id: true, fullName: true, email: true, role: true, department: true, institutionId: true, studentId: true, affiliationType: true, affiliationName: true, phone: true, disabled: true, emailVerified: true };
extraRouter.get('/users', requireRole('ADMIN'), async (_q, res) => res.json(await prisma.user.findMany({ select: userSel, orderBy: { fullName: 'asc' } })));
extraRouter.post('/users', requireRole('ADMIN'), async (req, res) => {
  const p = z.object({ fullName: z.string().min(2), email: z.string().email(), institutionId: z.string().optional(), studentId: z.string().optional(),
    department: z.string().optional(), affiliationType: z.enum(['STUDENT_BODY', 'DEPARTMENT']).optional(), affiliationName: z.string().optional(),
    phone: z.string().optional(), role: z.enum(['ADMIN', 'RESOURCE_MANAGER', 'FACULTY', 'STUDENT']), tempPassword: z.string().min(8) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Check the user details (temporary password needs 8+ characters).' });
  const { tempPassword, ...rest } = p.data;
  if (await prisma.user.findUnique({ where: { email: rest.email.toLowerCase() } })) return res.status(409).json({ error: 'A user with this email already exists.' });
  const identity = rest.studentId ?? rest.institutionId ?? '';
  const u = await prisma.user.create({ data: { ...rest, institutionId: identity || rest.institutionId || undefined, studentId: rest.studentId || rest.institutionId || undefined,
    email: rest.email.toLowerCase(), passwordHash: await bcrypt.hash(tempPassword, 12), mustChangePassword: true, emailVerified: false }, select: userSel });
  await audit(uid(req), 'USER_CREATED', 'User', u.id, undefined, { email: u.email, role: u.role, institutionId: u.institutionId, studentId: u.studentId, affiliationType: u.affiliationType, affiliationName: u.affiliationName });
  await notify(u.id, 'USER_CREATED', 'Welcome to CampusFlow', 'Your account is ready. You will be asked to change your password on first login.', 'Welcome to CampusFlow');
  res.status(201).json(u);
});
extraRouter.put('/users/:id', requireRole('ADMIN'), async (req, res) => {
  const p = z.object({ role: z.enum(['ADMIN', 'RESOURCE_MANAGER', 'FACULTY', 'STUDENT']).optional(), disabled: z.boolean().optional() }).safeParse(req.body);
  if (!p.success || req.params.id === uid(req)) return res.status(400).json({ error: "You can't change your own role or status." });
  const u = await prisma.user.update({ where: { id: req.params.id }, data: p.data, select: userSel });
  await audit(uid(req), 'USER_UPDATED', 'User', u.id, undefined, p.data);
  res.json(u);
});
extraRouter.delete('/users/:id', requireRole('ADMIN'), async (req, res) => { // soft delete keeps the audit trail intact
  if (req.params.id === uid(req)) return res.status(400).json({ error: "You can't disable yourself." });
  await prisma.user.update({ where: { id: req.params.id }, data: { disabled: true } });
  await audit(uid(req), 'USER_DISABLED', 'User', req.params.id);
  res.json({ ok: true });
});

// --- Admin override: preview -> confirm with reason; never silent ---
extraRouter.post('/bookings/override', requireRole('ADMIN'), async (req, res) => {
  const p = z.object({ resourceId: z.string(), title: z.string().min(2), attendees: z.number().int().positive(), start: z.coerce.date(), end: z.coerce.date(),
    priority: z.enum(['HIGH', 'CRITICAL']).default('HIGH'), reason: z.string().min(5).optional(), confirm: z.boolean().default(false) }).safeParse(req.body);
  if (!p.success || p.data.end <= p.data.start) return res.status(400).json({ error: 'Check the override details.' });
  const d = p.data, found = await findConflicts(prisma, d.resourceId, d.start, d.end);
  if (found.some(c => c.kind === 'MAINTENANCE')) return res.status(409).json({ error: 'Maintenance blocks cannot be overridden.' });
  if (!d.confirm || !d.reason) return res.status(409).json({ error: 'Confirm the override and give a reason.', affected: found });
  const out = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${d.resourceId}))`;
    const affected = await tx.booking.findMany({ where: { resourceId: d.resourceId, status: { in: ['PENDING', 'APPROVED'] }, startTime: { lt: d.end }, endTime: { gt: d.start } } });
    for (const a of affected) {
      await tx.booking.update({ where: { id: a.id }, data: { status: 'CANCELLED' } });
      await tx.bookingStatusHistory.create({ data: { bookingId: a.id, fromStatus: a.status, toStatus: 'CANCELLED', actorId: uid(req), reason: `Admin override: ${d.reason}` } });
      await tx.bookingToken.updateMany({ where: { bookingId: a.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    const b = await tx.booking.create({ data: { resourceId: d.resourceId, requesterId: uid(req), title: d.title, attendees: d.attendees, priority: d.priority, status: 'APPROVED', startTime: d.start, endTime: d.end } });
    await tx.bookingStatusHistory.create({ data: { bookingId: b.id, toStatus: 'APPROVED', actorId: uid(req), reason: d.reason } });
    return { b, affected };
  });
  for (const a of out.affected) await notify(a.requesterId, 'ADMIN_OVERRIDE', '⚠ Booking overridden', `"${a.title}" was cancelled by an administrator. Reason: ${d.reason}`, 'CampusFlow — Booking Overridden');
  await audit(uid(req), 'ADMIN_OVERRIDE', 'Booking', out.b.id, { affected: out.affected.map(a => a.id) }, { reason: d.reason });
  res.status(201).json(out.b);
});

// --- Waitlist ---
extraRouter.post('/waitlist', async (req, res) => {
  const p = z.object({ resourceId: z.string(), title: z.string().min(2), attendees: z.number().int().positive(), start: z.coerce.date(), end: z.coerce.date() }).safeParse(req.body);
  if (!p.success || p.data.end <= p.data.start) return res.status(400).json({ error: 'Check the waitlist details.' });
  const { start, end, ...rest } = p.data;
  res.status(201).json(await prisma.waitlist.create({ data: { ...rest, startTime: start, endTime: end, userId: uid(req) } }));
});

// --- Smart natural-language resource search ---
import { parseQuery } from '../services/nlParse.js';
extraRouter.post('/resources/smart-search', async (req, res) => {
  const p = z.object({ query: z.string().min(3).max(300) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Describe what you need, e.g. "a room for 80 people tomorrow 3-5 PM with a projector".' });
  const c = parseQuery(p.data.query);
  const cands = await prisma.resource.findMany({ where: { status: 'ACTIVE', type: c.type as any, capacity: { gte: c.capacity ?? 0 }, facilities: c.facilities.length ? { hasEvery: c.facilities } : undefined }, orderBy: { capacity: 'asc' } });
  const results = [];
  for (const r of cands) if (!c.start || !c.end || !(await findConflicts(prisma, r.id, c.start, c.end)).length) results.push({ ...r, availability: c.start ? 'AVAILABLE' : 'ANY TIME' });
  const bits = [c.capacity && `capacity ≥ ${c.capacity}`, c.facilities.length && c.facilities.join(' + '), c.type && c.type.replace('_', ' ').toLowerCase(), c.start && `${c.start.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} – ${c.end!.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`].filter(Boolean);
  res.json({ summary: bits.length ? `Understood: ${bits.join(' · ')}` : 'Could not detect specific needs; showing everything.', criteria: c, results });
});

// --- Predictive conflict warning from the same slot on the previous 8 weeks ---
extraRouter.get('/resources/:id/risk', async (req, res) => {
  const p = z.object({ start: z.coerce.date(), end: z.coerce.date() }).safeParse(req.query);
  if (!p.success || p.data.end <= p.data.start) return res.status(400).json({ error: 'Invalid window.' });
  const since = new Date(p.data.start.getTime() - 57 * 86_400_000);
  const past = await prisma.booking.findMany({ where: { resourceId: req.params.id, status: { in: ['PENDING', 'APPROVED', 'COMPLETED'] }, startTime: { gte: since, lt: p.data.start } }, select: { startTime: true, endTime: true } });
  let busy = 0;
  for (let k = 1; k <= 8; k++) {
    const s = p.data.start.getTime() - k * 7 * 86_400_000, e = p.data.end.getTime() - k * 7 * 86_400_000;
    if (past.some(b => b.startTime.getTime() < e && b.endTime.getTime() > s)) busy++;
  }
  const pct = Math.round((busy / 8) * 100);
  res.json({ pct, level: pct >= 50 ? 'HIGH' : pct >= 25 ? 'MEDIUM' : 'LOW', weeks: 8 });
});

// --- Priority configuration (role -> default booking priority) ---
extraRouter.get('/priorities', requireRole('ADMIN'), async (_q, res) => res.json(await prisma.priorityRule.findMany()));
extraRouter.put('/priorities/:role', requireRole('ADMIN'), async (req, res) => {
  const p = z.object({ role: z.enum(['ADMIN', 'RESOURCE_MANAGER', 'FACULTY', 'STUDENT']), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']) }).safeParse({ role: req.params.role, priority: req.body?.priority });
  if (!p.success) return res.status(400).json({ error: 'Invalid priority.' });
  const r = await prisma.priorityRule.upsert({ where: { role: p.data.role }, update: { priority: p.data.priority }, create: p.data });
  await audit(uid(req), 'PRIORITY_RULE_UPDATED', 'PriorityRule', p.data.role, undefined, p.data);
  res.json(r);
});
