import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { config } from '../config/config';
import { NotFoundError, ConflictError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateStaffId } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { Role } from '../prisma/enums';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findStaff = (id: string) =>
  db.orm.public.Staff.where((staff) => or(staff.id.eq(id), staff.staffId.eq(id))).first();

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

      const existingUser = await db.orm.public.User.where({ email }).first();
      if (existingUser) throw new ConflictError('Email already in use');

      const staffId = generateStaffId();
      const hashedPass = await bcrypt.hash(password || `${firstName}@${new Date().getFullYear()}`, config.bcrypt.rounds);

      const staff = await db.transaction(async (tx) => {
        const user = await tx.orm.public.User.create({ email, password: hashedPass, role });

        const createdStaff = await tx.orm.public.Staff.create({
            userId: user.id,
            staffId,
            firstName, lastName, middleName, gender,
            dateOfBirth: toTimestampString(new Date(dateOfBirth)),
            phone, address, city, state, country,
            departmentId, position,
            hireDate: toTimestampString(new Date(hireDate)),
            salary,
        });

        if (role === Role.DOCTOR) {
          if (!licenseNumber) throw new ConflictError('License number required for doctors');
          await tx.orm.public.Doctor.create({
              staffId: createdStaff.id,
              licenseNumber, specializationId,
              qualification: qualification || 'MBBS',
              experience: experience || 0,
              consultationFee: consultationFee || 0,
              bio,
          });
        }

        if (role === Role.NURSE) {
          if (!licenseNumber) throw new ConflictError('License number required for nurses');
          await tx.orm.public.Nurse.create({
              staffId: createdStaff.id,
              licenseNumber, nurseType, wardId,
          });
        }

        return createdStaff;
      });

      const created = await db.orm.public.Staff
        .include('user', (user) => user.select('email', 'role'))
        .include('department')
        .include('doctor', (doctor) => doctor.include('specialization'))
        .include('nurse')
        .where({ id: staff.id })
        .first();

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

      const pattern = search ? `%${String(search).replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const query = db.orm.public.Staff.where((staff) =>
        and(
          pattern
            ? or(
                staff.firstName.ilike(pattern),
                staff.lastName.ilike(pattern),
                staff.staffId.ilike(pattern),
                staff.phone.ilike(pattern)
              )
            : all(),
          departmentId ? staff.departmentId.eq(departmentId as string) : all(),
          isOnDuty ? staff.isOnDuty.eq(isOnDuty === 'true') : all(),
          role ? staff.user.some({ role: role as Role }) : all()
        )
      );

      const [total, staff] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('user', (user) => user.select('email', 'role', 'isActive'))
          .include('department', (department) => department.select('name', 'code'))
          .include('doctor', (doctor) => doctor.include('specialization'))
          .include('nurse', (nurse) => nurse.select('id', 'licenseNumber', 'nurseType'))
          .orderBy((staff) => staff.createdAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, staff, 'Staff retrieved', 200, buildPaginationMeta(total.total, page, limit));
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
      const staff = await db.orm.public.Staff
        .include('user', (user) => user.select('email', 'role', 'isActive', 'lastLoginAt'))
        .include('department')
        .include('doctor', (doctor) => doctor.include('specialization'))
        .include('nurse', (nurse) => nurse.include('ward'))
        .include('shifts', (shifts) => shifts.orderBy((shift) => shift.startTime.desc()).limit(10))
        .where((record) => or(record.id.eq(id), record.staffId.eq(id)))
        .first();

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
      const existing = await findStaff(id);
      if (!existing) throw new NotFoundError('Staff not found');

      const {
        firstName, lastName, middleName, gender, dateOfBirth,
        phone, address, city, state, country, departmentId,
        position, salary, isOnDuty,
      } = req.body;

      const staff = await db.orm.public.Staff
        .include('user', (user) => user.select('email', 'role'))
        .include('department')
        .include('doctor')
        .include('nurse')
        .where({ id: existing.id })
        .update({
          firstName, lastName, middleName, gender,
          dateOfBirth: dateOfBirth ? toTimestampString(new Date(dateOfBirth)) : undefined,
          phone, address, city, state, country, departmentId, position, salary, isOnDuty,
      });
      if (!staff) throw new NotFoundError('Staff member not found');

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

      const doctors = await db.orm.public.Doctor
        .include('staff', (staff) =>
          staff
            .select('firstName', 'lastName', 'phone', 'profilePhoto', 'isOnDuty', 'departmentId')
            .include('department', (department) => department.select('name'))
        )
        .include('specialization')
        .where((doctor) =>
          and(
            specializationId ? doctor.specializationId.eq(specializationId as string) : all(),
            isAvailable !== undefined ? doctor.isAvailable.eq(isAvailable === 'true') : all(),
            departmentId ? doctor.staff.some({ departmentId: departmentId as string }) : all()
          )
        )
        .all();

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
      const staff = await findStaff(id);
      if (!staff) throw new NotFoundError('Staff not found');

      const { shiftType, startTime, endTime, notes } = req.body;
      const shift = await db.orm.public.Shift.create({
          staffId: staff.id,
          shiftType,
          startTime: toTimestampString(new Date(startTime)),
          endTime: toTimestampString(new Date(endTime)),
          notes,
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
      const staff = await findStaff(id);
      if (!staff) throw new NotFoundError('Staff not found');

      const shifts = await db.orm.public.Shift.where({ staffId: staff.id })
        .orderBy((shift) => shift.startTime.desc())
        .all();

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
      const staff = await db.orm.public.Staff.include('user').where((record) =>
        or(record.id.eq(id), record.staffId.eq(id))
      ).first();
      if (!staff) throw new NotFoundError('Staff not found');

      await db.orm.public.User.where({ id: staff.userId }).update({ isActive: false });

      await logAudit(req.user?.userId, 'DEACTIVATE', 'staff', staff.id);
      return sendSuccess(res, null, 'Staff account deactivated');
    } catch (error) {
      next(error);
    }
  }
}
