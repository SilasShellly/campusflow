import { Booking } from '@prisma/client';
import { prisma, findConflicts } from './bookingService.js';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';

const when = (b: Booking) => `${b.startTime.toLocaleString()} – ${b.endTime.toLocaleString()}`;
const ticketId = (b: Booking) => `CF-${b.id.slice(0, 8).toUpperCase()}`;
const text: Record<string, [string, string, string]> = {
  APPROVED: ['BOOKING_APPROVED', '✓ Booking approved', 'CampusFlow — Booking Approved ✓'],
  REJECTED: ['BOOKING_REJECTED', '✕ Booking rejected', 'CampusFlow — Booking Request Rejected'],
  CANCELLED: ['BOOKING_CANCELLED', '✕ Booking cancelled', 'CampusFlow — Booking Cancelled'],
};
export async function onCreated(b: Booking) {
  const r = await prisma.resource.findUnique({ where: { id: b.resourceId } });
  await audit(b.requesterId, 'BOOKING_CREATED', 'Booking', b.id, undefined, { status: b.status });
  await notify(b.requesterId, 'BOOKING_REQUESTED', 'Booking request received', `${r?.name}, ${when(b)}. Ticket: ${ticketId(b)}. Status: ${b.status}`, 'CampusFlow — Booking Request Received');
}
export async function afterTransition(b: Booking, to: string, actorId: string, reason?: string) {
  const r = await prisma.resource.findUnique({ where: { id: b.resourceId } });
  if (to !== 'APPROVED') await prisma.bookingToken.updateMany({ where: { bookingId: b.id, revokedAt: null }, data: { revokedAt: new Date() } }); // revoke QR
  await audit(actorId, `BOOKING_${to}`, 'Booking', b.id, undefined, { status: to, reason });
  const [type, title, subject] = text[to];
  const body = to === 'APPROVED'
    ? `${r?.name}, ${when(b)}. Ticket: ${ticketId(b)}${reason ? `. Reason: ${reason}` : ''}. Please keep this confirmation handy for check-in.`
    : `${r?.name}, ${when(b)}${reason ? `. Reason: ${reason}` : ''}`;
  await notify(b.requesterId, type, title, body, subject);
  if (to !== 'APPROVED') await promoteWaitlist(b.resourceId, b.startTime, b.endTime);
}

/** A slot freed up: notify the first waiting user (oldest first) whose requested window is now actually free. */
export async function promoteWaitlist(resourceId: string, start: Date, end: Date) {
  const waiting = await prisma.waitlist.findMany({ where: { resourceId, notifiedAt: null, startTime: { lt: end }, endTime: { gt: start } }, orderBy: { createdAt: 'asc' } });
  for (const w of waiting) {
    if ((await findConflicts(prisma, resourceId, w.startTime, w.endTime)).length) continue;
    const claimed = await prisma.waitlist.updateMany({ where: { id: w.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
    if (!claimed.count) continue;
    const r = await prisma.resource.findUnique({ where: { id: resourceId } });
    await notify(w.userId, 'WAITLIST_AVAILABLE', '🔔 Slot available', `${r?.name} is now free for "${w.title}" (${w.startTime.toLocaleString()}). Book it before someone else does.`, 'CampusFlow — A slot you wanted is available');
    return;
  }
}
