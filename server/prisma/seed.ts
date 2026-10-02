import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const db = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Campus@123', 12);
  const users = [['admin', 'ADMIN', 'Asha Admin'], ['manager', 'RESOURCE_MANAGER', 'Mohan Manager'], ['faculty', 'FACULTY', 'Dr. Fiona Rao'], ['student', 'STUDENT', 'Alex Student']] as const;
  for (const [u, role, fullName] of users)
    await db.user.upsert({ where: { email: `${u}@campus.edu` }, update: {}, create: { email: `${u}@campus.edu`, fullName, role, passwordHash, mustChangePassword: false } });

  for (const [role, priority] of [['ADMIN', 'CRITICAL'], ['RESOURCE_MANAGER', 'HIGH'], ['FACULTY', 'NORMAL'], ['STUDENT', 'LOW']] as const)
    await db.priorityRule.upsert({ where: { role }, update: {}, create: { role, priority } });

  const R = (name: string, type: any, building: string, floor: number, capacity: number, facilities: string[], approvalRequired = true) =>
    ({ name, type, building, floor, capacity, facilities, approvalRequired });
  const resources = [
    R('Seminar Hall A', 'SEMINAR_HALL', 'Building 2', 1, 120, ['Projector', 'AC', 'Audio', 'Wi-Fi']),
    R('Seminar Hall B', 'SEMINAR_HALL', 'Building 2', 1, 120, ['Projector', 'AC', 'Wi-Fi']),
    R('Main Auditorium', 'AUDITORIUM', 'Building 1', 0, 250, ['Projector', 'AC', 'Audio', 'Stage']),
    R('Computer Lab 1', 'COMPUTER_LAB', 'Building 3', 2, 60, ['PCs', 'AC', 'Wi-Fi']),
    R('Computer Lab 2', 'COMPUTER_LAB', 'Building 3', 2, 60, ['PCs', 'AC', 'Wi-Fi']),
    R('Computer Lab 3', 'COMPUTER_LAB', 'Building 3', 3, 50, ['PCs', 'Wi-Fi']),
    R('Conference Room C', 'CONFERENCE_ROOM', 'Building 1', 2, 16, ['Projector', 'AC'], false),
    R('Classroom 101', 'CLASSROOM', 'Building 2', 1, 70, ['Projector']),
    R('Classroom 102', 'CLASSROOM', 'Building 2', 1, 70, ['Projector']),
    R('Football Ground', 'SPORTS_FACILITY', 'Sports Complex', 0, 300, ['Floodlights']),
  ];
  for (const r of resources) if (!(await db.resource.findFirst({ where: { name: r.name } }))) await db.resource.create({ data: r });

  // Demo story: Seminar Hall A is already booked tomorrow 2-4 PM, so the student hits a conflict.
  const hallA = await db.resource.findFirstOrThrow({ where: { name: 'Seminar Hall A' } });
  const faculty = await db.user.findUniqueOrThrow({ where: { email: 'faculty@campus.edu' } });
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(8, 30, 0, 0); // 2 PM IST
  const e = new Date(d.getTime() + 2 * 3600_000);
  if (!(await db.booking.findFirst({ where: { resourceId: hallA.id, startTime: d } })))
    await db.booking.create({ data: { resourceId: hallA.id, requesterId: faculty.id, title: 'Faculty Workshop', attendees: 80, status: 'APPROVED', startTime: d, endTime: e } });

  // 60 demo bookings across ~5 weeks: unique (resource, day) so none overlap.
  if ((await db.booking.count()) < 20) {
    const all = await db.resource.findMany({ orderBy: { name: 'asc' } }), student = await db.user.findUniqueOrThrow({ where: { email: 'student@campus.edu' } });
    const st = ['APPROVED', 'APPROVED', 'APPROVED', 'PENDING', 'REJECTED', 'CANCELLED'];
    for (let i = 0; i < 60; i++) {
      const day = Math.floor(i / 10) * 4 - 20, past = day < 0;
      const start = new Date(); start.setUTCDate(start.getUTCDate() + day); start.setUTCHours(4 + (i % 4) * 2, 0, 0, 0);
      let status = st[i % st.length]; if (past && status === 'PENDING') status = 'COMPLETED'; if (past && status === 'APPROVED') status = 'COMPLETED';
      await db.booking.create({ data: { resourceId: all[i % all.length].id, requesterId: i % 2 ? student.id : faculty.id, title: ['Guest Lecture', 'Club Meet', 'Exam Prep', 'Project Review'][i % 4],
        attendees: 20 + (i % 5) * 10, status: status as any, startTime: start, endTime: new Date(start.getTime() + 2 * 3600_000) } });
    }
    const lab = all.find(r => r.name === 'Computer Lab 1')!, m = new Date(); m.setUTCDate(m.getUTCDate() + 3); m.setUTCHours(3, 30, 0, 0);
    await db.resourceBlock.create({ data: { resourceId: lab.id, reason: 'Hardware upgrade', startTime: m, endTime: new Date(m.getTime() + 8 * 3600_000) } });
    await db.notification.createMany({ data: [{ userId: student.id, type: 'BOOKING_APPROVED', title: '✓ Booking approved', body: 'Your Exam Prep booking was approved.' }, { userId: student.id, type: 'RESOURCE_MAINTENANCE', title: '🔧 Resource maintenance', body: 'Computer Lab 1 will be under maintenance soon.' }] });
    await db.auditLog.create({ data: { action: 'SEEDED_DEMO_DATA', entity: 'System' } });
  }
  console.log('Seeded. Login: admin|manager|faculty|student@campus.edu / Campus@123');
}
main().finally(() => db.$disconnect());
