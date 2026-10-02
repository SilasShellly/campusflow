import { PrismaClient, Prisma, Priority } from '@prisma/client';

export const prisma = new PrismaClient();
type Db = Prisma.TransactionClient | PrismaClient;
const ACTIVE = ['PENDING', 'APPROVED'] as const;

export interface ConflictInfo { id: string; title: string; start: Date; end: Date; kind: 'BOOKING' | 'MAINTENANCE'; }

export class BookingConflictError extends Error {
  constructor(public conflicts: ConflictInfo[]) {
    super('Someone else booked this resource while you were submitting the request.');
  }
}
export class ValidationError extends Error {}

/** Overlap rule: existingStart < reqEnd AND existingEnd > reqStart. Adjacent slots pass. */
export async function findConflicts(db: Db, resourceId: string, start: Date, end: Date): Promise<ConflictInfo[]> {
  const [bookings, blocks] = await Promise.all([
    db.booking.findMany({ where: { resourceId, status: { in: [...ACTIVE] }, startTime: { lt: end }, endTime: { gt: start } } }),
    db.resourceBlock.findMany({ where: { resourceId, startTime: { lt: end }, endTime: { gt: start } } }),
  ]);
  return [
    ...bookings.map(b => ({ id: b.id, title: b.title, start: b.startTime, end: b.endTime, kind: 'BOOKING' as const })),
    ...blocks.map(b => ({ id: b.id, title: `Maintenance: ${b.reason}`, start: b.startTime, end: b.endTime, kind: 'MAINTENANCE' as const })),
  ];
}

export interface CreateBookingInput {
  resourceId: string; requesterId: string; title: string; purpose?: string;
  attendees: number; start: Date; end: Date; priority?: Priority;
}

export async function createBooking(input: CreateBookingInput) {
  const { resourceId, start, end } = input;
  if (!(end > start)) throw new ValidationError('End time must be after start time.');
  try {
    return await prisma.$transaction(async tx => {
      // Serialize writers per resource; the exclusion constraint is the final safety net.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${resourceId}))`;

      const resource = await tx.resource.findUniqueOrThrow({ where: { id: resourceId } });
      if (resource.status !== 'ACTIVE') throw new ValidationError('Resource is not available for booking.');
      if (input.attendees > resource.capacity) throw new ValidationError(`Capacity is ${resource.capacity}.`);
      if ((end.getTime() - start.getTime()) / 60000 > resource.maxDurationMin) throw new ValidationError('Booking exceeds the maximum duration.');

      const conflicts = await findConflicts(tx, resourceId, start, end);
      if (conflicts.length) throw new BookingConflictError(conflicts);

      const status = resource.approvalRequired ? 'PENDING' : 'APPROVED';
      const booking = await tx.booking.create({
        data: {
          resourceId, requesterId: input.requesterId, title: input.title, purpose: input.purpose,
          attendees: input.attendees, priority: input.priority ?? 'NORMAL', status, startTime: start, endTime: end,
        },
      });
      await tx.bookingStatusHistory.create({ data: { bookingId: booking.id, toStatus: status, actorId: input.requesterId } });
      return booking;
    });
  } catch (e) {
    // Exclusion-constraint violation = a concurrent writer slipped through: report as a normal conflict.
    if (String(e).includes('bookings_no_overlap')) {
      throw new BookingConflictError(await findConflicts(prisma, resourceId, start, end));
    }
    throw e;
  }
}
