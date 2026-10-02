import { prisma } from './bookingService.js';
export const audit = (userId: string | null, action: string, entity: string, entityId?: string, oldValue?: object, newValue?: object) =>
  prisma.auditLog.create({ data: { userId, action, entity, entityId, oldValue: oldValue as any, newValue: newValue as any } }).catch(e => console.error('audit failed', e));
