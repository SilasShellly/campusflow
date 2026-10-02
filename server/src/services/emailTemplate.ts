const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
export const APP_URL = () => process.env.APP_URL ?? 'http://localhost:5173';
export const BUTTON: Record<string, string> = { BOOKING_APPROVED: 'View Booking', BOOKING_REJECTED: 'Find Alternative', BOOKING_REMINDER: 'View QR Pass', WAITLIST_AVAILABLE: 'Book Now' };
export const emailHtml = (title: string, body: string, label: string, url = APP_URL()) =>
  `<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px"><h2 style="color:#111827;margin:0 0 12px">${esc(title)}</h2><p style="color:#374151;line-height:1.5;white-space:pre-line">${esc(body)}</p><a href="${esc(url)}" style="display:inline-block;background:#4338ca;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(label)}</a></div>`;
