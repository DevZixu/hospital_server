import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config';
import { db } from '../config/database';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { Role } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  role: Role;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('No token provided');
    }

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;

    const user = await db.orm.public.User
      .select('id', 'role', 'email', 'isActive')
      .where({ id: payload.userId })
      .first();

    if (!user || !user.isActive) {
      throw new UnauthorizedError('Account not found or inactive');
    }

    req.user = { userId: user.id, role: user.role, email: user.email };
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new UnauthorizedError('Invalid token'));
    } else if (error instanceof jwt.TokenExpiredError) {
      next(new UnauthorizedError('Token expired'));
    } else {
      next(error);
    }
  }
};

export const authorize = (...roles: Role[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(
        `Access denied. Required roles: ${roles.join(', ')}`
      );
    }
    next();
  };
};

export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const payload = jwt.verify(token, config.jwt.secret) as JwtPayload;
      const user = await db.orm.public.User
        .select('id', 'role', 'email', 'isActive')
        .where({ id: payload.userId })
        .first();
      if (user && user.isActive) {
        req.user = { userId: user.id, role: user.role, email: user.email };
      }
    }
    next();
  } catch {
    next();
  }
};
