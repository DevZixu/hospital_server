import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError, AppError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateAppointmentNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { AppointmentStatus, AppointmentType } from '@prisma/client';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findAppointment = (id: string) =>
  db.orm.public.Appointment.where((appointment) =>
    or(appointment.id.eq(id), appointment.appointmentNo.eq(id))
  ).first();

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
        db.orm.public.Patient.where((patient) =>
          or(patient.id.eq(patientId), patient.patientId.eq(patientId))
        ).first(),
        db.orm.public.Doctor.where((doctor) =>
          or(doctor.id.eq(doctorId), doctor.staff.some({ staffId: doctorId }))
        ).first(),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      // Check for scheduling conflicts
      const scheduledDate = new Date(scheduledAt);
      const endTime = new Date(scheduledDate.getTime() + (duration || 30) * 60000);

      const conflict = await db.orm.public.Appointment.where((appointment) =>
        and(
          appointment.doctorId.eq(doctor.id),
          appointment.status.neq(AppointmentStatus.CANCELLED),
          appointment.status.neq(AppointmentStatus.NO_SHOW),
          appointment.scheduledAt.lt(toTimestampString(endTime)),
          appointment.scheduledAt.gte(
            toTimestampString(new Date(scheduledDate.getTime() - 30 * 60000))
          )
        )
      ).first();

      if (conflict) {
        throw new AppError('Doctor has a conflicting appointment at this time', 409);
      }

      const appointment = await db.orm.public.Appointment.create({
          appointmentNo: generateAppointmentNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          departmentId,
          type,
          scheduledAt: toTimestampString(scheduledDate),
          duration: duration || 30,
          chiefComplaint,
          notes,
          isFollowUp: isFollowUp || false,
          parentAppointmentId,
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

      let start: Date | undefined;
      let end: Date | undefined;
      if (date) {
        start = new Date(date as string);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
      }

      const query = db.orm.public.Appointment.where((appointment) =>
        and(
          patientId ? appointment.patientId.eq(patientId as string) : all(),
          doctorId ? appointment.doctorId.eq(doctorId as string) : all(),
          status ? appointment.status.eq(status as AppointmentStatus) : all(),
          type ? appointment.type.eq(type as AppointmentType) : all(),
          departmentId ? appointment.departmentId.eq(departmentId as string) : all(),
          start && end
            ? and(
                appointment.scheduledAt.gte(toTimestampString(start)),
                appointment.scheduledAt.lt(toTimestampString(end))
              )
            : all()
        )
      );
      const [total, appointments] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId', 'phone'))
          .include('doctor', (doctor) =>
            doctor
              .include('staff', (staff) => staff.select('firstName', 'lastName'))
              .include('specialization')
          )
          .include('department', (department) => department.select('name'))
          .orderBy((appointment) => appointment.scheduledAt.asc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, appointments, 'Appointments retrieved', 200, buildPaginationMeta(total.total, page, limit));
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
      const appointment = await db.orm.public.Appointment
        .include('patient')
        .include('doctor', (doctor) => doctor.include('staff').include('specialization'))
        .include('department')
        .include('medicalRecord', (record) => record.include('diagnoses').include('vitalSigns'))
        .include('followUps')
        .include('parentAppointment')
        .where((record) => or(record.id.eq(id), record.appointmentNo.eq(id)))
        .first();

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

      const appointment = await findAppointment(id);
      if (!appointment) throw new NotFoundError('Appointment not found');

      const updateData: Record<string, unknown> = { status };
      if (status === AppointmentStatus.CHECKED_IN) updateData.checkedInAt = toTimestampString(new Date());
      if (status === AppointmentStatus.COMPLETED) updateData.completedAt = toTimestampString(new Date());
      if (status === AppointmentStatus.CANCELLED) {
        updateData.cancelledAt = toTimestampString(new Date());
        updateData.cancellationReason = cancellationReason;
      }

      const updated = await db.orm.public.Appointment
        .include('patient', (patient) => patient.select('firstName', 'lastName'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .where({ id: appointment.id })
        .update(updateData as { status: AppointmentStatus });
      if (!updated) throw new NotFoundError('Appointment not found');

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

      const appointment = await findAppointment(id);
      if (!appointment) throw new NotFoundError('Appointment not found');

      if (
        appointment.status === AppointmentStatus.COMPLETED ||
        appointment.status === AppointmentStatus.CANCELLED
      ) {
        throw new AppError('Cannot reschedule a completed or cancelled appointment', 400);
      }

      const updated = await db.orm.public.Appointment.where({ id: appointment.id }).update({
          scheduledAt: toTimestampString(new Date(scheduledAt)),
          duration: duration || appointment.duration,
          status: AppointmentStatus.RESCHEDULED,
      });
      if (!updated) throw new NotFoundError('Appointment not found');

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

      const doctor = await db.orm.public.Doctor.where((record) =>
        or(record.id.eq(doctorId), record.staff.some({ staffId: doctorId }))
      ).first();
      if (!doctor) throw new NotFoundError('Doctor not found');

      const queryDate = date ? new Date(date as string) : new Date();
      const startOfDay = new Date(queryDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(queryDate.setHours(23, 59, 59, 999));

      const appointments = await db.orm.public.Appointment
        .select('scheduledAt', 'duration', 'status')
        .where((appointment) =>
          and(
            appointment.doctorId.eq(doctor.id),
            appointment.scheduledAt.gte(toTimestampString(startOfDay)),
            appointment.scheduledAt.lte(toTimestampString(endOfDay)),
            appointment.status.neq(AppointmentStatus.CANCELLED),
            appointment.status.neq(AppointmentStatus.NO_SHOW)
          )
        )
        .orderBy((appointment) => appointment.scheduledAt.asc())
        .all();

      return sendSuccess(res, { doctorId: doctor.id, date: startOfDay, appointments });
    } catch (error) {
      next(error);
    }
  }
}
