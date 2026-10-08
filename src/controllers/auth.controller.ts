import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../config/database';
import { config } from '../config/config';
import { AppError, ConflictError, UnauthorizedError, NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated } from '../utils/response';
import { generateToken } from '../utils/helpers';
import { Role } from '@prisma/client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { logAudit } from '../middleware/audit.middleware';

const toTimestampString = (date: Date): TimestampString<3> =>
  date.toISOString() as TimestampString<3>;

const signAccessToken = (userId: string, role: Role, email: string): string =>
  jwt.sign({ userId, role, email }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);

const signRefreshToken = (userId: string): string =>
  jwt.sign({ userId }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);

export class AuthController {
  /**
   * POST /auth/register
   * Register a new user (PATIENT by default, or any role if ADMIN)
   */
  static async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const role = Role.PATIENT;

      const existing = await db.orm.public.User.where({ email }).first();
      if (existing) throw new ConflictError('Email already in use');

      const hashed = await bcrypt.hash(password, config.bcrypt.rounds);
      const verifyToken = generateToken();

      const user = await db.orm.public.User.create({
          email,
          password: hashed,
          role,
          emailVerifyToken: verifyToken,
        });

      await logAudit(user.id, 'REGISTER', 'user', user.id, null, { email, role });

      return sendCreated(res, user, 'Account created successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/login
   */
  static async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;

      const user = await db.orm.public.User
        .select('id', 'email', 'password', 'role', 'isActive', 'isEmailVerified')
        .where({ email })
        .first();

      if (!user || !(await bcrypt.compare(password, user.password))) {
        throw new UnauthorizedError('Invalid email or password');
      }

      if (!user.isActive) {
        throw new UnauthorizedError('Account is deactivated. Contact support.');
      }

      const accessToken = signAccessToken(user.id, user.role, user.email);
      const refreshToken = signRefreshToken(user.id);

      // Store refresh token
      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 30);

      await db.orm.public.RefreshToken.create({
          token: refreshToken,
          userId: user.id,
            expiresAt: toTimestampString(refreshExpiry),
      });

          await db.orm.public.User.where({ id: user.id }).update({ lastLoginAt: toTimestampString(new Date()) });

      await logAudit(user.id, 'LOGIN', 'user', user.id, null, null, req.ip, req.headers['user-agent']);

      return sendSuccess(res, {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
        },
        tokens: { accessToken, refreshToken },
      }, 'Login successful');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/refresh
   */
  static async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) throw new UnauthorizedError('Refresh token required');

      let payload: { userId: string };
      try {
        payload = jwt.verify(refreshToken, config.jwt.refreshSecret) as { userId: string };
      } catch {
        throw new UnauthorizedError('Invalid or expired refresh token');
      }

      const stored = await db.orm.public.RefreshToken
        .select('id', 'token', 'userId', 'expiresAt')
        .include('user', (user) => user.select('id', 'email', 'role', 'isActive'))
        .where({ token: refreshToken })
        .first();

      if (!stored || !stored.user || new Date(stored.expiresAt) < new Date()) {
        throw new UnauthorizedError('Refresh token expired or not found');
      }

      if (!stored.user.isActive) {
        throw new UnauthorizedError('Account is deactivated');
      }

      // Rotate refresh token
      const newRefreshExpiry = new Date();
      newRefreshExpiry.setDate(newRefreshExpiry.getDate() + 30);

      const newRefreshToken = signRefreshToken(stored.userId);
      const newAccessToken = signAccessToken(stored.user.id, stored.user.role, stored.user.email);

      await db.transaction(async (tx) => {
        await tx.orm.public.RefreshToken.where({ id: stored.id }).delete();
        await tx.orm.public.RefreshToken.create({
          token: newRefreshToken,
          userId: stored.userId,
          expiresAt: toTimestampString(newRefreshExpiry),
        });
      });

      return sendSuccess(res, {
        tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken },
      }, 'Token refreshed');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/logout
   */
  static async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      if (refreshToken) {
        await db.orm.public.RefreshToken.where({ token: refreshToken }).deleteAndCount();
      }
      return sendSuccess(res, null, 'Logged out successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /auth/me
   */
  static async me(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const user = await db.orm.public.User
        .select('id', 'email', 'role', 'isActive', 'isEmailVerified', 'lastLoginAt', 'createdAt')
        .include('staff', (staff) =>
          staff
            .select('id', 'staffId', 'firstName', 'lastName', 'profilePhoto')
            .include('department', (department) => department.select('name'))
            .include('doctor', (doctor) =>
              doctor
                .select('id', 'licenseNumber')
                .include('specialization', (specialization) => specialization.select('name'))
            )
            .include('nurse', (nurse) => nurse.select('id', 'licenseNumber'))
        )
        .include('patient', (patient) =>
          patient.select('id', 'patientId', 'firstName', 'lastName', 'profilePhoto', 'bloodGroup')
        )
        .where({ id: userId })
        .first();

      if (!user) throw new NotFoundError('User not found');
      return sendSuccess(res, user);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/change-password
   */
  static async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { currentPassword, newPassword } = req.body;
      const userId = req.user!.userId;

      const user = await db.orm.public.User.select('id', 'password').where({ id: userId }).first();
      if (!user) throw new NotFoundError();

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) throw new UnauthorizedError('Current password is incorrect');

      const hashed = await bcrypt.hash(newPassword, config.bcrypt.rounds);
      await db.transaction(async (tx) => {
        await tx.orm.public.User.where({ id: userId }).update({ password: hashed });
        await tx.orm.public.RefreshToken.where({ userId }).deleteAndCount();
      });

      await logAudit(userId, 'CHANGE_PASSWORD', 'user', userId);

      return sendSuccess(res, null, 'Password changed successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/forgot-password
   */
  static async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const user = await db.orm.public.User.select('id').where({ email }).first();

      // Always return success to prevent user enumeration
      if (user) {
        const resetToken = generateToken();
        const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await db.orm.public.User.where({ id: user.id }).update({
          passwordResetToken: resetToken,
          passwordResetExpiry: toTimestampString(expiry),
        });
        // TODO: Send email with reset link
        console.log(`Password reset token for ${email}: ${resetToken}`);
      }

      return sendSuccess(res, null, 'If your email exists, a reset link has been sent');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /auth/reset-password
   */
  static async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, newPassword } = req.body;

      const user = await db.orm.public.User
        .where({ passwordResetToken: token })
        .where((user) => user.passwordResetExpiry.gte(toTimestampString(new Date())))
        .first();

      if (!user) throw new AppError('Invalid or expired reset token', 400);

      const hashed = await bcrypt.hash(newPassword, config.bcrypt.rounds);
      await db.transaction(async (tx) => {
        await tx.orm.public.User.where({ id: user.id }).update({
          password: hashed,
          passwordResetToken: null,
          passwordResetExpiry: null,
        });
        await tx.orm.public.RefreshToken.where({ userId: user.id }).deleteAndCount();
      });

      return sendSuccess(res, null, 'Password reset successfully');
    } catch (error) {
      next(error);
    }
  }
}
