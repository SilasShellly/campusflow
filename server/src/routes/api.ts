import { Router } from 'express';
import { z } from 'zod';
import { prisma, createBooking, BookingConflictError, ValidationError } from '../services/bookingService.js';
import { resolve } from '../services/conflictResolutionService.js';
import { requireAuth, requireRole, AuthedRequest } from './auth.js';
import { onCreated, afterTransition } from '../services/hooks.js';

export const apiRouter = Router();
apiRouter.use(requireAuth);
const MANAGE = ['ADMIN', 'RESOURCE_MANAGER'] as const;

// Live status computed from the DB: never hardcoded.
async function liveStatus(resourceId: string, now = new Date()) {
  if (await prisma.resourceBlock.findFirst({ where: { resourceId, startTime: { lte: now }, endTime: { gt: now } } })) return 'MAINTENANCE';
  const b = await prisma.booking.findFirst({ where: { resourceId, status: { in: ['PENDING', 'APPROVED'] }, startTime: { lte: now }, endTime: { gt: now } } });
  return b ? (b.status === 'APPROVED' ? 'BOOKED' : 'PENDING') : 'AVAILABLE';
}

apiRouter.get('/resources', async (req, res) => {
  const q = z.object({ search: z.string().optional(), type: z.string().optional(), building: z.string().optional(), minCapacity: z.coerce.number().optional() }).parse(req.query);
  const rows = await prisma.resource.findMany({
    where: { status: { not: 'RETIRED' }, type: q.type as any, building: q.building, capacity: { gte: q.minCapacity ?? 0 }, name: q.search ? { contains: q.search, mode: 'insensitive' } : undefined },
    orderBy: { name: 'asc' },
  });
  res.json(await Promise.all(rows.map(async r => ({ ...r, availability: await liveStatus(r.id) }))));
});

apiRouter.get('/resources/:id/availability', async (req, res) => {
  const day = new Date(String(req.query.date ?? new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  const next = new Date(day.getTime() + 86_400_000);
  const where = { resourceId: req.params.id, startTime: { lt: next }, endTime: { gt: day } };
  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({ where: { ...where, status: { in: ['PENDING', 'APPROVED'] } }, select: { startTime: true, endTime: true, status: true, title: true } }),
    prisma.resourceBlock.findMany({ where }),
  ]);
  res.json({ bookings, blocks });
});

const bookingSchema = z.object({
  resourceId: z.string(), title: z.string().min(2).max(120), purpose: z.string().max(500).optional(),
  attendees: z.number().int().positive(), start: z.coerce.date(), end: z.coerce.date(), requiredFacilities: z.array(z.string()).optional(),
});

apiRouter.post('/bookings', async (req, res) => {
  const p = bookingSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Please check the booking details.' });
  try {
    const { id: requesterId, role } = (req as AuthedRequest).user;
    const rule = await prisma.priorityRule.findUnique({ where: { role } });
    const booking = await createBooking({ ...p.data, priority: rule?.priority, requesterId });
    void onCreated(booking); res.status(201).json(booking);
  } catch (e) {
    if (e instanceof BookingConflictError) {
      // Don't stop at "unavailable": explain and recommend.
      const report = await resolve(p.data.resourceId, p.data.start, p.data.end, p.data.attendees, p.data.requiredFacilities);
      return res.status(409).json({ error: e.message, ...report });
    }
    if (e instanceof ValidationError) return res.status(422).json({ error: e.message });
    throw e;
  }
});

apiRouter.get('/bookings', async (req, res) => {
  const { id, role } = (req as AuthedRequest).user;
  const where = role === 'ADMIN' || role === 'RESOURCE_MANAGER' ? {} : { requesterId: id };
  res.json(await prisma.booking.findMany({ where, include: { resource: true, requester: { select: { fullName: true } } }, orderBy: { startTime: 'desc' }, take: 200 }));
});

async function transitionTx(id: string, to: 'APPROVED' | 'REJECTED' | 'CANCELLED', actorId: string, from: string[], reason?: string) {
  return prisma.$transaction(async tx => {
    const b = await tx.booking.findUnique({ where: { id } });
    if (!b || !from.includes(b.status)) return null;
    await tx.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: b.status, toStatus: to, actorId, reason } });
    return tx.booking.update({ where: { id }, data: { status: to } });
  });
}

apiRouter.post('/bookings/:id/approve', requireRole(...MANAGE), async (req, res) => {
  const b = await transition(req.params.id, 'APPROVED', (req as AuthedRequest).user.id, ['PENDING']);
  b ? res.json(b) : res.status(409).json({ error: 'This request is no longer pending.' });
});

apiRouter.post('/bookings/:id/reject', requireRole(...MANAGE), async (req, res) => {
  const p = z.object({ reason: z.string().min(3) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Please give a reason.' });
  const b = await transition(req.params.id, 'REJECTED', (req as AuthedRequest).user.id, ['PENDING'], p.data.reason);
  b ? res.json(b) : res.status(409).json({ error: 'This request is no longer pending.' });
});

apiRouter.post('/bookings/:id/cancel', async (req, res) => {
  const { id: uid, role } = (req as AuthedRequest).user;
  const existing = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!existing || (existing.requesterId !== uid && role !== 'ADMIN')) return res.status(404).json({ error: 'Booking not found.' });
  const b = await transition(existing.id, 'CANCELLED', uid, ['PENDING', 'APPROVED']);
  b ? res.json(b) : res.status(409).json({ error: 'This booking can no longer be cancelled.' });
});

apiRouter.get('/me', async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: (req as AuthedRequest).user.id }, select: { id: true, fullName: true, role: true, email: true } });
  u ? res.json(u) : res.status(401).json({ error: 'Please sign in.' });
});

async function transition(id: string, to: 'APPROVED' | 'REJECTED' | 'CANCELLED', actorId: string, from: string[], reason?: string) {
  const b = await transitionTx(id, to, actorId, from, reason);
  if (b) void afterTransition(b, to, actorId, reason);
  return b;
}
