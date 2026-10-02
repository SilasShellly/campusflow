import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../services/bookingService.js';
import { sendEmail } from '../services/notificationService.js';
import { audit } from '../services/auditService.js';
import { emailHtml } from '../services/emailTemplate.js';

const SECRET = process.env.JWT_SECRET!;
export type AuthedRequest = Request & { user: { id: string; role: Role } };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const otpCode = () => `${Math.floor(100000 + Math.random() * 900000)}`;
const normalizeIdentity = (value?: string) => value?.trim().toLowerCase() || '';
const findUserByIdentity = async (identity: string) => {
  const normalized = normalizeIdentity(identity);
  if (!normalized) return null;
  return prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: normalized, mode: 'insensitive' } },
        { institutionId: { equals: normalized, mode: 'insensitive' } },
        { studentId: { equals: normalized, mode: 'insensitive' } },
      ],
    },
  });
};

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const p = z.object({
    email: z.string().email().optional(),
    identifier: z.string().optional(),
    institutionId: z.string().optional(),
    password: z.string().min(1),
    otp: z.string().length(6).optional(),
  }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter a valid email or ID and password.' });

  const identity = normalizeIdentity(p.data.email ?? p.data.identifier ?? p.data.institutionId);
  const user = await findUserByIdentity(identity);

  const ok = user && !user.disabled && (await bcrypt.compare(p.data.password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  if (!user.emailVerified) {
    if (!p.data.otp) return res.status(403).json({ error: 'Verify your email with the OTP sent to your inbox.' });
    const record = await prisma.emailOtp.findFirst({
      where: { email: user.email.toLowerCase(), purpose: 'EMAIL_VERIFICATION', expiresAt: { gt: new Date() }, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const valid = !!record && (record.code === p.data.otp || record.codeHash === sha(p.data.otp));
    if (!valid) return res.status(403).json({ error: 'Invalid or expired OTP.' });
    const claimed = await prisma.emailOtp.updateMany({ where: { id: record!.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (!claimed.count) return res.status(403).json({ error: 'Invalid or expired OTP.' });
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }

  const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '8h' });
  res.cookie('cf_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600_000 });
  res.json({ id: user.id, name: user.fullName, role: user.role, mustChangePassword: user.mustChangePassword });
});

authRouter.post('/send-otp', async (req, res) => {
  const p = z.object({ email: z.string().email().optional(), identifier: z.string().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter a valid email address or campus ID.' });
  const identity = normalizeIdentity(p.data.email ?? p.data.identifier);
  const user = identity ? await findUserByIdentity(identity) : null;
  const email = user ? user.email.toLowerCase() : normalizeIdentity(p.data.email);
  if (!email) return res.status(404).json({ error: 'No account found for that email or ID.' });
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email verification is unavailable. Please contact an administrator.' });
  const code = otpCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const record = await prisma.emailOtp.create({ data: { email, code, codeHash: sha(code), purpose: 'EMAIL_VERIFICATION', expiresAt } });
  const sent = await sendEmail(email, 'CampusFlow — Verify your email', `Your one-time verification code is ${code}. It expires in 10 minutes.`, emailHtml('Verify your email', `Use this one-time code to confirm your CampusFlow account.\n\nCode: ${code}\n\nThis code expires in 10 minutes.`, 'Open CampusFlow'));
  if (!sent) {
    await prisma.emailOtp.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return res.status(503).json({ error: 'We could not send the verification email. Please try again later.' });
  }
  await prisma.user.updateMany({ where: { email }, data: { emailVerified: false } });
  res.json({ ok: true, expiresInMinutes: 10, email });
});

authRouter.post('/verify-otp', async (req, res) => {
  const p = z.object({ email: z.string().email(), otp: z.string().length(6) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });
  const email = p.data.email.toLowerCase();
  const record = await prisma.emailOtp.findFirst({
    where: { email, purpose: 'EMAIL_VERIFICATION', expiresAt: { gt: new Date() }, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  const otp = p.data.otp.trim();
  const valid = !!record && (record.code === otp || record.codeHash === sha(otp));
  if (!valid) return res.status(400).json({ error: 'The OTP is invalid or expired.' });
  const claimed = await prisma.emailOtp.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
  if (!claimed.count) return res.status(400).json({ error: 'The OTP is invalid or expired.' });
  await prisma.user.updateMany({ where: { email }, data: { emailVerified: true } });
  res.json({ ok: true, verified: true });
});

authRouter.post('/logout', (_req, res) => { res.clearCookie('cf_token'); res.json({ ok: true }); });

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    (req as AuthedRequest).user = jwt.verify(req.cookies?.cf_token, SECRET) as AuthedRequest['user'];
    next();
  } catch { res.status(401).json({ error: 'Please sign in.' }); }
}
export const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) =>
  roles.includes((req as AuthedRequest).user.role) ? next() : res.status(403).json({ error: "You don't have access to this." });

const pw = z.string().min(8).max(100);

authRouter.post('/forgot-password', async (req, res) => {
  const p = z.object({ email: z.string().email().optional(), identifier: z.string().optional() }).safeParse(req.body);
  if (p.success) {
    const identity = p.data.email ?? p.data.identifier;
    const u = identity ? await findUserByIdentity(identity) : null;
    if (u && !u.disabled) {
      const raw = randomBytes(32).toString('base64url');   // only the hash is stored
      await prisma.passwordResetToken.create({ data: { tokenHash: sha(raw), userId: u.id, expiresAt: new Date(Date.now() + 30 * 60_000) } });
      const link = `${process.env.APP_URL ?? 'http://localhost:5173'}/?reset=${raw}`;
      void sendEmail(u.email, 'CampusFlow — Reset your password', `Reset link (valid 30 minutes, single use):\n${link}`, emailHtml('Reset your password', 'This link is valid for 30 minutes and can be used once.', 'Reset password', link));
    }
  }
  res.json({ ok: true }); // same reply whether or not the account exists
});

authRouter.post('/reset-password', async (req, res) => {
  const p = z.object({ token: z.string().min(20), password: pw }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const hash = await bcrypt.hash(p.data.password, 12);
  const ok = await prisma.$transaction(async tx => {
    // Atomic claim: only one request can flip usedAt from null.
    const c = await tx.passwordResetToken.updateMany({ where: { tokenHash: sha(p.data.token), usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (c.count !== 1) return false;
    const t = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: sha(p.data.token) } });
    await tx.user.update({ where: { id: t.userId }, data: { passwordHash: hash, mustChangePassword: false } });
    return t.userId;
  });
  if (!ok) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  await audit(ok as string, 'PASSWORD_RESET', 'User', ok as string);
  res.json({ ok: true });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const p = z.object({ current: z.string(), password: pw }).safeParse(req.body);
  const u = p.success && await prisma.user.findUnique({ where: { id: (req as AuthedRequest).user.id } });
  if (!p.success || !u || !(await bcrypt.compare(p.data.current, u.passwordHash))) return res.status(400).json({ error: 'Check your current password and choose 8+ characters.' });
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(p.data.password, 12), mustChangePassword: false } });
  res.json({ ok: true });
});
