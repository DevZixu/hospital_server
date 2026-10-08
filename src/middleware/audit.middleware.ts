import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { JwtPayload } from './auth.middleware';

export const auditLog = (action: string, resource: string) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Store metadata for logging after route completion
    const user = req.user as JwtPayload | undefined;
    req.body.__audit = {
      userId: user?.userId,
      action,
      resource,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    };
    next();
  };
};

export const logAudit = async (
  userId: string | undefined,
  action: string,
  resource: string,
  resourceId?: string,
  oldValue?: unknown,
  newValue?: unknown,
  ipAddress?: string,
  userAgent?: string
) => {
  try {
    await db.orm.public.AuditLog.create({
        userId,
        action,
        resource,
        resourceId,
        oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : undefined,
        newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : undefined,
        ipAddress,
        userAgent,
    });
  } catch (error) {
    console.error('Audit log error:', error);
  }
};
