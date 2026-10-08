import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { config } from '../config/config';
import { NotFoundError, ConflictError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateStaffId } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { Role } from '@prisma/client';

export class StaffController {
  /**
   * POST /staff
   * Create a new staff member (creates User + Staff + optional Doctor/Nurse)
   */
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        email, password, role,
        firstName, lastName, middleName, gender, dateOfBirth,
        phone, address, city, state, country, departmentId,
        position, hireDate, salary,
        // Doctor-specific
        licenseNumber, specializationId, qualification, experience, consultationFee, bio,
        // Nurse-specific
        nurseType, wardId,
      } = req.body;

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) throw new ConflictError('Email already in use');

      const staffId = generateStaffId();
      const hashedPass = await bcrypt.hash(password || `${firstName}@${new Date().getFullYear()}`, config.bcrypt.rounds);

      const staff = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, password: hashedPass, role },
        });

        const staff = await tx.staff.create({
          data: {
            userId: user.id,
            staffId,
            firstName, lastName, middleName, gender,
            dateOfBirth: new Date(dateOfBirth),
            phone, address, city, state, country,
            departmentId, position,
            hireDate: new Date(hireDate),
            salary,
          },
        });

        if (role === Role.DOCTOR) {
          if (!licenseNumber) throw new Error('License number required for doctors');
          await tx.doctor.create({
            data: {
              staffId: staff.id,
              licenseNumber, specializationId,
              qualification: qualification || 'MBBS',
              experience: experience || 0,
              consultationFee: consultationFee || 0,
              bio,
            },
          });
        }

        if (role === Role.NURSE) {
          if (!licenseNumber) throw new Error('License number required for nurses');
          await tx.nurse.create({
            data: {
              staffId: staff.id,
              licenseNumber, nurseType, wardId,
            },
          });
        }

        return staff;
      });

      const created = await prisma.staff.findUnique({
        where: { id: staff.id },
        include: {
          user: { select: { email: true, role: true } },
          department: true,
          doctor: { include: { specialization: true } },
          nurse: true,
        },
      });

      await logAudit(req.user?.userId, 'CREATE', 'staff', staff.id, null, created, req.ip);
      return sendCreated(res, created, 'Staff member created successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /staff
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { search, departmentId, role, isOnDuty } = req.query;

      const where: Record<string, unknown> = {};
      if (search) {
        where.OR = [
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName: { contains: search as string, mode: 'insensitive' } },
          { staffId: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ];
      }
      if (departmentId) where.departmentId = departmentId;
      if (isOnDuty) where.isOnDuty = isOnDuty === 'true';
      if (role) {
        where.user = { role };
      }

      const [total, staff] = await Promise.all([
        prisma.staff.count({ where }),
        prisma.staff.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { email: true, role: true, isActive: true } },
            department: { select: { name: true, code: true } },
            doctor: { include: { specialization: true } },
            nurse: { select: { id: true, licenseNumber: true, nurseType: true } },
          },
        }),
      ]);

      return sendSuccess(res, staff, 'Staff retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /staff/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const staff = await prisma.staff.findFirst({
        where: { OR: [{ id }, { staffId: id }] },
        include: {
          user: { select: { email: true, role: true, isActive: true, lastLoginAt: true } },
          department: true,
          doctor: { include: { specialization: true } },
          nurse: { include: { ward: true } },
          shifts: { orderBy: { startTime: 'desc' }, take: 10 },
        },
      });

      if (!staff) throw new NotFoundError('Staff member not found');
      return sendSuccess(res, staff);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /staff/:id
   */
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const existing = await prisma.staff.findFirst({
        where: { OR: [{ id }, { staffId: id }] },
      });
      if (!existing) throw new NotFoundError('Staff not found');

      const {
        firstName, lastName, middleName, gender, dateOfBirth,
        phone, address, city, state, country, departmentId,
        position, salary, isOnDuty,
      } = req.body;

      const staff = await prisma.staff.update({
        where: { id: existing.id },
        data: {
          firstName, lastName, middleName, gender,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          phone, address, city, state, country, departmentId, position, salary, isOnDuty,
        },
        include: {
          user: { select: { email: true, role: true } },
          department: true,
          doctor: true,
          nurse: true,
        },
      });

      await logAudit(req.user?.userId, 'UPDATE', 'staff', staff.id, existing, staff);
      return sendSuccess(res, staff, 'Staff updated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /staff/doctors - Get all doctors with availability
   */
  static async getDoctors(req: Request, res: Response, next: NextFunction) {
    try {
      const { specializationId, departmentId, isAvailable } = req.query;

      const where: Record<string, unknown> = {};
      if (specializationId) where.specializationId = specializationId;
      if (isAvailable !== undefined) where.isAvailable = isAvailable === 'true';
      if (departmentId) where.staff = { departmentId };

      const doctors = await prisma.doctor.findMany({
        where,
        include: {
          staff: {
            select: {
              firstName: true, lastName: true, phone: true,
              profilePhoto: true, isOnDuty: true, departmentId: true,
              department: { select: { name: true } },
            },
          },
          specialization: true,
        },
      });

      return sendSuccess(res, doctors, 'Doctors retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /staff/:id/shifts
   */
  static async createShift(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const staff = await prisma.staff.findFirst({
        where: { OR: [{ id }, { staffId: id }] },
      });
      if (!staff) throw new NotFoundError('Staff not found');

      const { shiftType, startTime, endTime, notes } = req.body;
      const shift = await prisma.shift.create({
        data: {
          staffId: staff.id,
          shiftType,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          notes,
        },
      });

      return sendCreated(res, shift, 'Shift scheduled');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /staff/:id/shifts
   */
  static async getShifts(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const staff = await prisma.staff.findFirst({
        where: { OR: [{ id }, { staffId: id }] },
      });
      if (!staff) throw new NotFoundError('Staff not found');

      const shifts = await prisma.shift.findMany({
        where: { staffId: staff.id },
        orderBy: { startTime: 'desc' },
      });

      return sendSuccess(res, shifts, 'Shifts retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /staff/:id
   */
  static async deactivate(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const staff = await prisma.staff.findFirst({
        where: { OR: [{ id }, { staffId: id }] },
        include: { user: true },
      });
      if (!staff) throw new NotFoundError('Staff not found');

      await prisma.user.update({
        where: { id: staff.userId },
        data: { isActive: false },
      });

      await logAudit(req.user?.userId, 'DEACTIVATE', 'staff', staff.id);
      return sendSuccess(res, null, 'Staff account deactivated');
    } catch (error) {
      next(error);
    }
  }
}
