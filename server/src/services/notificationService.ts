import { prisma } from './bookingService.js';
import { emailHtml, BUTTON } from './emailTemplate.js';

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const log = await prisma.emailLog.create({ data: { toEmail: to, subject, status: 'PENDING' } });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set (email skipped)');
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.EMAIL_FROM ?? 'CampusFlow <onboarding@resend.dev>', to, subject, text, html }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}`);
      await prisma.emailLog.update({ where: { id: log.id }, data: { status: 'SENT', attempts: attempt } });
      return true;
    } catch (e) {
      await prisma.emailLog.update({ where: { id: log.id }, data: { attempts: attempt, status: attempt === 3 ? 'FAILED' : 'RETRYING', error: String(e) } });
      if (!process.env.RESEND_API_KEY) return false;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return false;
}

/** DB notification + email. Never throws, so a mail outage can't fail a booking. */
export async function notify(userId: string, type: string, title: string, body: string, emailSubject?: string) {
  try {
    await prisma.notification.create({ data: { userId, type, title, body } });
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (u && emailSubject) void sendEmail(u.email, emailSubject, `${body}\n\nOpen CampusFlow to view details.`, emailHtml(title, body, BUTTON[type] ?? 'Open CampusFlow'));
  } catch (e) { console.error('notify failed', e); }
}
