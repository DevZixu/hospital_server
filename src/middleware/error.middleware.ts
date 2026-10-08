import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { Prisma } from '@prisma/client';
import { config } from '../config/config';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Operational errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errors: err.errors,
      ...(config.env === 'development' && { stack: err.stack }),
    });
    return;
  }

  // Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const field = (err.meta?.target as string[])?.join(', ') || 'field';
      res.status(409).json({
        success: false,
        message: `Duplicate value for ${field}. This record already exists.`,
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        message: 'Record not found',
      });
      return;
    }
    if (err.code === 'P2003') {
      res.status(400).json({
        success: false,
        message: 'Related record not found',
      });
      return;
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({
      success: false,
      message: 'Invalid data provided',
      ...(config.env === 'development' && { detail: err.message }),
    });
    return;
  }

  const databaseError = err as Error & {
    code?: unknown;
    sqlState?: unknown;
    meta?: { target?: unknown };
    details?: { sqlState?: unknown };
  };
  const sqlState = databaseError.sqlState ?? databaseError.details?.sqlState;
  if (sqlState === '23505') {
    res.status(409).json({ success: false, message: 'A record with this value already exists.' });
    return;
  }
  if (sqlState === '23503') {
    res.status(400).json({ success: false, message: 'Related record not found.' });
    return;
  }

  if (typeof databaseError.code === 'string') {
    if (databaseError.code === 'RUNTIME.NO_ROWS' || databaseError.code === 'ORM.MUTATION_ROW_MISSING') {
      res.status(404).json({ success: false, message: 'Record not found' });
      return;
    }
    if (databaseError.code === 'RUNTIME.ENCODE_FAILED' || databaseError.code === 'ORM.ARGUMENT_INVALID') {
      res.status(400).json({
        success: false,
        message: 'Invalid data provided',
        ...(config.env === 'development' && { detail: err.message }),
      });
      return;
    }
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    res.status(401).json({ success: false, message: 'Invalid token' });
    return;
  }
  if (err.name === 'TokenExpiredError') {
    res.status(401).json({ success: false, message: 'Token expired' });
    return;
  }

  // Generic 500
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(config.env === 'development' && { detail: err.message, stack: err.stack }),
  });
};

export const notFound = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};
