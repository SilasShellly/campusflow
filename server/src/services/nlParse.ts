// Deterministic natural-language parser (no external API needed, so the demo never breaks).
export interface Criteria { capacity?: number; facilities: string[]; type?: string; start?: Date; end?: Date }
const FAC: [RegExp, string][] = [[/projector/, 'Projector'], [/\bac\b|air.?con/, 'AC'], [/audio|mic|sound/, 'Audio'], [/wi-?fi/, 'Wi-Fi'], [/\bpcs?\b|computers?/, 'PCs'], [/stage/, 'Stage']];
const TYPE: [RegExp, string][] = [[/auditorium/, 'AUDITORIUM'], [/\blab\b/, 'COMPUTER_LAB'], [/seminar|\bhall\b/, 'SEMINAR_HALL'], [/conference|meeting/, 'CONFERENCE_ROOM'], [/classroom/, 'CLASSROOM'], [/ground|court|field/, 'SPORTS_FACILITY']];
const h24 = (h: number, suf?: string) => (suf === 'pm' ? (h % 12) + 12 : suf === 'am' ? h % 12 : h);

export function parseQuery(q: string, now = new Date()): Criteria {
  const t = q.toLowerCase(), c: Criteria = { facilities: [] };
  const cap = t.match(/(\d+)\s*(?:people|persons?|students|seats|attendees|pax)/); if (cap) c.capacity = Number(cap[1]);
  for (const [re, name] of FAC) if (re.test(t)) c.facilities.push(name);
  for (const [re, name] of TYPE) if (re.test(t)) { c.type = name; break; }
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  if (/tomorrow/.test(t)) day.setDate(day.getDate() + 1);
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (tm) {
    const h1 = Number(tm[1]), h2 = Number(tm[4]);
    const s1 = tm[3] ?? (h1 > h2 && h2 !== 12 ? 'am' : tm[6]);
    c.start = new Date(day); c.start.setHours(h24(h1, s1), Number(tm[2] ?? 0));
    c.end = new Date(day); c.end.setHours(h24(h2, tm[6]), Number(tm[5] ?? 0));
  }
  return c;
}
