import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma, createBooking } from '../src/services/bookingService.js';

const H = 3600_000, base = Date.now() + 3 * 86_400_000;
const slot = (from: number, to: number) => ({ start: new Date(base + from * H), end: new Date(base + to * H) });
const wait = (ms = 400) => new Promise(r => setTimeout(r, ms));
const U: Record<string, string> = {}; let rid = '';
const login = async (u: string, pw = 'Passw0rd!') => { const a = request.agent(app); const r = await a.post('/api/auth/login').send({ email: `${u}@campus.edu`, password: pw }); return Object.assign(a, { status: r.status, body: r.body }); };
const book = (who: string, from: number, to: number, approval = true) => createBooking({ resourceId: rid, requesterId: U[who], title: 'Test event', attendees: 10, ...slot(from, to) }).then(b => b);

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE "BookingToken","BookingStatusHistory","Booking","ResourceBlock","Resource","User","Waitlist","Notification","AuditLog","PasswordResetToken","EmailLog" CASCADE`;
  const passwordHash = await bcrypt.hash('Passw0rd!', 4);
  for (const [u, role] of [['admin', 'ADMIN'], ['manager', 'RESOURCE_MANAGER'], ['student', 'STUDENT'], ['other', 'STUDENT']] as const)
    U[u] = (await prisma.user.create({ data: { email: `${u}@campus.edu`, fullName: u, role, passwordHash, mustChangePassword: false } })).id;
  rid = (await prisma.resource.create({ data: { name: 'Test Hall', type: 'SEMINAR_HALL', building: 'B', floor: 1, capacity: 100, facilities: [] } })).id;
});

describe('auth & RBAC', () => {
  it('logs in and rejects bad credentials', async () => {
    expect((await login('student')).status).toBe(200);
    expect((await login('student', 'wrong')).status).toBe(401);
  });
  it('accepts student/faculty login by ID and verifies OTP flows', async () => {
    const student = await prisma.user.findUniqueOrThrow({ where: { email: 'student@campus.edu' } });
    await prisma.user.update({ where: { id: student.id }, data: { institutionId: 'STU-1001', studentId: 'STU-1001' } });
    expect((await request(app).post('/api/auth/login').send({ institutionId: 'STU-1001', password: 'Passw0rd!' })).status).toBe(200);
    vi.stubEnv('RESEND_API_KEY', '');
    expect((await request(app).post('/api/auth/send-otp').send({ email: 'student@campus.edu' })).status).toBe(503);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: student.id } })).emailVerified).toBe(true);
    vi.stubEnv('RESEND_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
    try {
      const otpRes = await request(app).post('/api/auth/send-otp').send({ email: 'student@campus.edu' });
      expect(otpRes.status).toBe(200);
      const code = await prisma.emailOtp.findFirst({ where: { email: 'student@campus.edu', purpose: 'EMAIL_VERIFICATION' }, orderBy: { createdAt: 'desc' } });
      expect((await request(app).post('/api/auth/login').send({ institutionId: 'STU-1001', password: 'Passw0rd!' })).status).toBe(403);
      expect(code).not.toBeNull();
      const verifiedLogin = await request(app).post('/api/auth/login').send({ institutionId: 'STU-1001', password: 'Passw0rd!', otp: code!.code });
      expect(verifiedLogin.status).toBe(200);
      const nextOtp = await request(app).post('/api/auth/send-otp').send({ email: 'student@campus.edu' });
      expect(nextOtp.status).toBe(200);
      const latestCode = await prisma.emailOtp.findFirst({ where: { email: 'student@campus.edu', purpose: 'EMAIL_VERIFICATION' }, orderBy: { createdAt: 'desc' } });
      const verify = await request(app).post('/api/auth/verify-otp').send({ email: 'student@campus.edu', otp: latestCode!.code });
      expect(verify.status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it('blocks users from privileged routes', async () => {
    const s = await login('student'); const b = await book('student', 1, 2);
    expect((await s.post(`/api/bookings/${b.id}/approve`)).status).toBe(403);
    expect((await s.get('/api/users')).status).toBe(403);
    expect((await request(app).get('/api/bookings')).status).toBe(401);
  });
});

describe('approval, rejection, maintenance', () => {
  it('approves a pending booking and requires a reason to reject', async () => {
    const m = await login('manager'); const a = await book('student', 3, 4), r = await book('student', 5, 6);
    expect((await m.post(`/api/bookings/${a.id}/approve`)).body.status).toBe('APPROVED');
    expect((await m.post(`/api/bookings/${r.id}/reject`).send({})).status).toBe(400);
    expect((await m.post(`/api/bookings/${r.id}/reject`).send({ reason: 'Exam hall' })).body.status).toBe('REJECTED');
  });
  it('refuses bookings inside a maintenance block', async () => {
    const m = await login('manager'); const { start, end } = slot(20, 28);
    expect((await m.post(`/api/resources/${rid}/block`).send({ start, end, reason: 'Repairs' })).status).toBe(201);
    const s = await login('student');
    const r = await s.post('/api/bookings').send({ resourceId: rid, title: 'During repairs', attendees: 5, start: slot(21, 22).start, end: slot(21, 22).end });
    expect(r.status).toBe(409); expect(r.body.conflicts[0].kind).toBe('MAINTENANCE');
  });
});

describe('QR', () => {
  it('verifies valid, rejects invalid, revoked and expired', async () => {
    const s = await login('student'), m = await login('manager');
    const b = await createBooking({ resourceId: rid, requesterId: U.student, title: 'QR', attendees: 5, start: new Date(Date.now() - H / 2), end: new Date(Date.now() + H) });
    await m.post(`/api/bookings/${b.id}/approve`);
    const { token } = (await s.post(`/api/bookings/${b.id}/qr`)).body;
    expect((await m.post('/api/qr/verify').send({ token })).body.valid).toBe(true);
    expect((await s.post('/api/qr/verify').send({ token })).status).toBe(403);       // only staff verify
    expect((await m.post('/api/qr/verify').send({ token: 'x'.repeat(30) })).body.valid).toBe(false);
    await s.post(`/api/bookings/${b.id}/cancel`); await wait();
    expect((await m.post('/api/qr/verify').send({ token })).body.reason).toBe('QR was revoked');
    const old = await prisma.booking.create({ data: { resourceId: rid, requesterId: U.student, title: 'Old', attendees: 1, status: 'APPROVED', startTime: new Date(Date.now() - 5 * H), endTime: new Date(Date.now() - 4 * H) } });
    const t = await prisma.bookingToken.create({ data: { bookingId: old.id, token: randomBytes(24).toString('base64url') } });
    expect((await m.post('/api/qr/verify').send({ token: t.token })).body.reason).toBe('Booking expired');
  });
});

describe('password reset', () => {
  it('is single-use and expires', async () => {
    const mk = async (exp: number) => { const raw = randomBytes(32).toString('base64url'); await prisma.passwordResetToken.create({ data: { tokenHash: createHash('sha256').update(raw).digest('hex'), userId: U.other, expiresAt: new Date(Date.now() + exp) } }); return raw; };
    const raw = await mk(60_000);
    expect((await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'NewPassw0rd!' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: raw, password: 'Another1234' })).status).toBe(400);
    expect((await login('other', 'NewPassw0rd!')).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: await mk(-1000), password: 'Another1234' })).status).toBe(400);
  });
});

describe('admin override & waitlist', () => {
  it('previews, requires a reason, cancels the victim and notifies them', async () => {
    const a = await login('admin'); const v = await book('other', 40, 42); const { start, end } = slot(40, 42);
    const body = { resourceId: rid, title: 'Emergency', attendees: 20, start, end };
    const preview = await a.post('/api/bookings/override').send(body);
    expect(preview.status).toBe(409); expect(preview.body.affected).toHaveLength(1);
    expect((await a.post('/api/bookings/override').send({ ...body, confirm: true })).status).toBe(409);   // reason missing
    expect((await a.post('/api/bookings/override').send({ ...body, confirm: true, reason: 'Institutional event' })).status).toBe(201);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: v.id } })).status).toBe('CANCELLED');
    expect(await prisma.notification.count({ where: { userId: U.other, type: 'ADMIN_OVERRIDE' } })).toBe(1);
  });
  it('notifies the first waitlisted user when a slot frees up', async () => {
    const o = await login('other', 'NewPassw0rd!'), s = await login('student'); const b = await book('student', 50, 52); const { start, end } = slot(50, 52);
    expect((await o.post('/api/waitlist').send({ resourceId: rid, title: 'Wanted', attendees: 5, start, end })).status).toBe(201);
    await s.post(`/api/bookings/${b.id}/cancel`); await wait(600);
    expect(await prisma.notification.count({ where: { userId: U.other, type: 'WAITLIST_AVAILABLE' } })).toBe(1);
  });
});
