import { beforeAll, describe, expect, it } from 'vitest';
import { prisma, createBooking, BookingConflictError } from '../src/services/bookingService.js';

const at = (h: number) => new Date(Date.UTC(2026, 9, 12, h));
let resourceId: string, userId: string;

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE "BookingStatusHistory","Booking","ResourceBlock","Resource","User","Waitlist","Notification" CASCADE`;
  userId = (await prisma.user.create({ data: { email: 't@campus.edu', fullName: 'T', passwordHash: 'x', role: 'STUDENT' } })).id;
  resourceId = (await prisma.resource.create({ data: { name: 'Seminar Hall A', type: 'SEMINAR_HALL', building: '2', floor: 1, capacity: 120, facilities: ['Projector'] } })).id;
});
const book = (s: number, e: number) => createBooking({ resourceId, requesterId: userId, title: 't', attendees: 50, start: at(s), end: at(e) });

describe('booking engine', () => {
  it('rejects overlapping bookings', async () => {
    await book(14, 16);
    await expect(book(15, 17)).rejects.toBeInstanceOf(BookingConflictError);
  });
  it('allows adjacent bookings', async () => {
    await expect(book(16, 18)).resolves.toBeTruthy();
  });
  it('lets only one of 10 simultaneous identical requests succeed', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(9, 11)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected' && r.reason instanceof BookingConflictError)).toHaveLength(9);
  });
});
