import { Resource } from '@prisma/client';
import { prisma, findConflicts, ConflictInfo } from './bookingService.js';

export interface Alternative { resource: Resource; start: Date; end: Date; score: number; reasons: string[]; }
export interface ConflictReport {
  requested: { resource: Resource; start: Date; end: Date };
  conflicts: ConflictInfo[]; alternatives: Alternative[];
}
const MIN = 60_000;

/** Explains a conflict and ranks alternatives. Every suggestion carries human-readable reasons. */
export async function resolve(resourceId: string, start: Date, end: Date, attendees: number, requiredFacilities: string[] = []): Promise<ConflictReport> {
  const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
  const conflicts = await findConflicts(prisma, resourceId, start, end);
  const durationMs = end.getTime() - start.getTime();
  const needed = requiredFacilities.length ? requiredFacilities : resource.facilities;
  const alts: Alternative[] = [];

  // 1) Same type, enough capacity, free at the SAME time; scored on building, capacity fit, facilities.
  const peers = await prisma.resource.findMany({
    where: { id: { not: resourceId }, type: resource.type, status: 'ACTIVE', capacity: { gte: attendees } },
  });
  for (const p of peers) {
    if ((await findConflicts(prisma, p.id, start, end)).length) continue;
    const missing = needed.filter(f => !p.facilities.includes(f));
    let score = 40; const reasons = ['Free at your exact requested time'];
    if (p.building === resource.building) { score += 20; reasons.push(`Same building (${p.building})`); }
    const slack = (p.capacity - attendees) / Math.max(attendees, 1);
    score += Math.max(0, 20 - Math.round(slack * 20));
    reasons.push(`Capacity ${p.capacity} for ${attendees} attendees${slack > 1 ? ' (much larger than needed)' : ''}`);
    score += Math.round(20 * (1 - missing.length / Math.max(needed.length, 1)));
    reasons.push(missing.length ? `Missing: ${missing.join(', ')}` : `Has all facilities: ${needed.join(', ') || 'none required'}`);
    alts.push({ resource: p, start, end, score, reasons });
  }

  // 2) Same resource, nearest free slot within ±4h (30-min steps), same duration.
  for (let shift = 30; shift <= 240; shift += 30) {
    for (const dir of [1, -1]) {
      const s = new Date(start.getTime() + dir * shift * MIN), e = new Date(s.getTime() + durationMs);
      if ((await findConflicts(prisma, resourceId, s, e)).length) continue;
      alts.push({
        resource, start: s, end: e, score: 60 - shift / 6,
        reasons: ['Same room, so facilities and capacity are unchanged', `${shift} min ${dir > 0 ? 'later' : 'earlier'} than requested`],
      });
      break;
    }
  }
  alts.sort((a, b) => b.score - a.score);
  return { requested: { resource, start, end }, conflicts, alternatives: alts.slice(0, 5) };
}
