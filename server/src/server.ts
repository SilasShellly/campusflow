import { app } from './app.js';
import { prisma } from './services/bookingService.js';
import { notify } from './services/notificationService.js';

// Reminders: 30 minutes before start. The updateMany claim makes each reminder fire exactly once.
setInterval(async () => {
  const soon = await prisma.booking.findMany({ where: { status: 'APPROVED', reminderSentAt: null, startTime: { gt: new Date(), lte: new Date(Date.now() + 30 * 60_000) } }, include: { resource: true } });
  for (const b of soon) {
    const c = await prisma.booking.updateMany({ where: { id: b.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
    if (c.count) await notify(b.requesterId, 'BOOKING_REMINDER', '📅 Booking reminder', `Your booking at ${b.resource.name} begins within 30 minutes.`, 'CampusFlow — Booking Reminder');
  }
}, 60_000).unref();

app.listen(Number(process.env.PORT ?? 4000), () => console.log('CampusFlow API up'));
