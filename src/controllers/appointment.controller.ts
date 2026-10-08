import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError, AppError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateAppointmentNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { AppointmentStatus } from '@prisma/client';

export class AppointmentController {
  /**
   * POST /appointments
   */
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, doctorId, departmentId, type, scheduledAt,
        duration, chiefComplaint, notes, isFollowUp, parentAppointmentId,
      } = req.body;

      // Validate patient and doctor exist
      const [patient, doctor] = await Promise.all([
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findFirst({ where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      // Check for scheduling conflicts
      const scheduledDate = new Date(scheduledAt);
      const endTime = new Date(scheduledDate.getTime() + (duration || 30) * 60000);

      const conflict = await prisma.appointment.findFirst({
        where: {
          doctorId: doctor.id,
          status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
          scheduledAt: { lt: endTime },
          AND: {
            scheduledAt: { gte: new Date(scheduledDate.getTime() - 30 * 60000) },
          },
        },
      });

      if (conflict) {
        throw new AppError('Doctor has a conflicting appointment at this time', 409);
      }

      const appointment = await prisma.appointment.create({
        data: {
          appointmentNo: generateAppointmentNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          departmentId,
          type,
          scheduledAt: scheduledDate,
          duration: duration || 30,
          chiefComplaint,
          notes,
          isFollowUp: isFollowUp || false,
          parentAppointmentId,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true, phone: true } },
          doctor: {
            include: {
              staff: { select: { firstName: true, lastName: true } },
              specialization: true,
            },
          },
          department: true,
        },
      });

      await logAudit(req.user?.userId, 'CREATE', 'appointment', appointment.id, null, appointment);
      return sendCreated(res, appointment, 'Appointment scheduled successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /appointments
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, doctorId, status, type, date, departmentId } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (doctorId) where.doctorId = doctorId;
      if (status) where.status = status;
      if (type) where.type = type;
      if (departmentId) where.departmentId = departmentId;
      if (date) {
        const start = new Date(date as string);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        where.scheduledAt = { gte: start, lt: end };
      }

      const [total, appointments] = await Promise.all([
        prisma.appointment.count({ where }),
        prisma.appointment.findMany({
          where,
          skip,
          take: limit,
          orderBy: { scheduledAt: 'asc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true, phone: true } },
            doctor: {
              include: {
                staff: { select: { firstName: true, lastName: true } },
                specialization: true,
              },
            },
            department: { select: { name: true } },
          },
        }),
      ]);

      return sendSuccess(res, appointments, 'Appointments retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /appointments/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const appointment = await prisma.appointment.findFirst({
        where: { OR: [{ id }, { appointmentNo: id }] },
        include: {
          patient: true,
          doctor: {
            include: {
              staff: true,
              specialization: true,
            },
          },
          department: true,
          medicalRecord: {
            include: { diagnoses: true, vitalSigns: true },
          },
          followUps: true,
          parentAppointment: true,
        },
      });

      if (!appointment) throw new NotFoundError('Appointment not found');
      return sendSuccess(res, appointment);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /appointments/:id/status
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status, cancellationReason } = req.body;

      const appointment = await prisma.appointment.findFirst({
        where: { OR: [{ id }, { appointmentNo: id }] },
      });
      if (!appointment) throw new NotFoundError('Appointment not found');

      const updateData: Record<string, unknown> = { status };
      if (status === AppointmentStatus.CHECKED_IN) updateData.checkedInAt = new Date();
      if (status === AppointmentStatus.COMPLETED) updateData.completedAt = new Date();
      if (status === AppointmentStatus.CANCELLED) {
        updateData.cancelledAt = new Date();
        updateData.cancellationReason = cancellationReason;
      }

      const updated = await prisma.appointment.update({
        where: { id: appointment.id },
        data: updateData,
        include: {
          patient: { select: { firstName: true, lastName: true } },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
        },
      });

      await logAudit(req.user?.userId, `APPOINTMENT_${status}`, 'appointment', appointment.id);
      return sendSuccess(res, updated, `Appointment ${status.toLowerCase()}`);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /appointments/:id/reschedule
   */
  static async reschedule(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { scheduledAt, duration } = req.body;

      const appointment = await prisma.appointment.findFirst({
        where: { OR: [{ id }, { appointmentNo: id }] },
      });
      if (!appointment) throw new NotFoundError('Appointment not found');

      if (
        appointment.status === AppointmentStatus.COMPLETED ||
        appointment.status === AppointmentStatus.CANCELLED
      ) {
        throw new AppError('Cannot reschedule a completed or cancelled appointment', 400);
      }

      const updated = await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          scheduledAt: new Date(scheduledAt),
          duration: duration || appointment.duration,
          status: AppointmentStatus.RESCHEDULED,
        },
      });

      await logAudit(req.user?.userId, 'RESCHEDULE', 'appointment', appointment.id);
      return sendSuccess(res, updated, 'Appointment rescheduled');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /appointments/doctor/:doctorId/availability
   */
  static async getDoctorAvailability(req: Request, res: Response, next: NextFunction) {
    try {
      const { doctorId } = req.params;
      const { date } = req.query;

      const doctor = await prisma.doctor.findFirst({
        where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] },
      });
      if (!doctor) throw new NotFoundError('Doctor not found');

      const queryDate = date ? new Date(date as string) : new Date();
      const startOfDay = new Date(queryDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(queryDate.setHours(23, 59, 59, 999));

      const appointments = await prisma.appointment.findMany({
        where: {
          doctorId: doctor.id,
          scheduledAt: { gte: startOfDay, lte: endOfDay },
          status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        },
        orderBy: { scheduledAt: 'asc' },
        select: { scheduledAt: true, duration: true, status: true },
      });

      return sendSuccess(res, { doctorId: doctor.id, date: startOfDay, appointments });
    } catch (error) {
      next(error);
    }
  }
}
