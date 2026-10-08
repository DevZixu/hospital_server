import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateEmergencyVisitNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { EmergencyStatus, EmergencyPriority } from '../prisma/enums';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findVisit = (id: string) =>
  db.orm.public.EmergencyVisit.where((visit) => or(visit.id.eq(id), visit.visitNo.eq(id))).first();

export class EmergencyController {
  /**
   * POST /emergency/triage
   * Triage a new emergency patient (can be walk-in or registered)
   */
  static async triage(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, walkinName, walkinAge, walkinGender,
        chiefComplaint, priority, triageNotes,
        vitalSystolic, vitalDiastolic, vitalHR, vitalTemp, vitalO2Sat, vitalRR,
      } = req.body;

      let resolvedPatientId: string | undefined;
      if (patientId) {
        const patient = await db.orm.public.Patient.where((record) =>
          or(record.id.eq(patientId), record.patientId.eq(patientId))
        ).first();
        if (!patient) throw new NotFoundError('Patient not found');
        resolvedPatientId = patient.id;
      }

      const created = await db.orm.public.EmergencyVisit.create({
          visitNo: generateEmergencyVisitNo(),
          patientId: resolvedPatientId,
          walkinName, walkinAge, walkinGender,
          chiefComplaint,
          priority: priority || EmergencyPriority.P3_LESS_URGENT,
          triageNotes,
          vitalSystolic, vitalDiastolic, vitalHR, vitalTemp, vitalO2Sat, vitalRR,
      });
      const visit = await db.orm.public.EmergencyVisit
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .where({ id: created.id })
        .first();
      if (!visit) throw new NotFoundError('Emergency visit could not be created');

      await logAudit(req.user?.userId, 'TRIAGE', 'emergency_visit', visit.id, null, visit);
      return sendCreated(res, visit, 'Emergency visit created');
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/visits
   */
  static async getVisits(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { status, priority, date } = req.query;

      let start: Date | undefined;
      let end: Date | undefined;
      if (date) {
        start = new Date(date as string);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
      }
      const query = db.orm.public.EmergencyVisit.where((visit) =>
        and(
          status ? visit.status.eq(status as EmergencyStatus) : all(),
          priority ? visit.priority.eq(priority as EmergencyPriority) : all(),
          start && end
            ? and(visit.triageTime.gte(toTimestampString(start)), visit.triageTime.lt(toTimestampString(end)))
            : all()
        )
      );

      const [total, visits] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId', 'phone'))
          .orderBy((visit) => visit.triageTime.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, visits, 'Emergency visits retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/visits/:id
   */
  static async getVisit(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const visit = await db.orm.public.EmergencyVisit
        .include('patient')
        .where((record) => or(record.id.eq(id), record.visitNo.eq(id)))
        .first();
      if (!visit) throw new NotFoundError('Emergency visit not found');
      return sendSuccess(res, visit);
    } catch (error) { next(error); }
  }

  /**
   * PATCH /emergency/visits/:id/assign
   */
  static async assignDoctor(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { doctorId, roomNo } = req.body;

      const visit = await findVisit(id);
      if (!visit) throw new NotFoundError('Emergency visit not found');

      const updated = await db.orm.public.EmergencyVisit.where({ id: visit.id }).update({
          assignedDoctorId: doctorId,
          roomNo,
          status: EmergencyStatus.IN_TREATMENT,
      });
      if (!updated) throw new NotFoundError('Emergency visit not found');

      return sendSuccess(res, updated, 'Doctor assigned');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /emergency/visits/:id/status
   */
  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status, treatmentNotes, dispositionNotes } = req.body;

      const visit = await findVisit(id);
      if (!visit) throw new NotFoundError('Emergency visit not found');

      const updateData: Record<string, unknown> = { status };
      if (treatmentNotes) updateData.treatmentNotes = treatmentNotes;
      if (dispositionNotes) updateData.dispositionNotes = dispositionNotes;
      if (status === EmergencyStatus.DISCHARGED) updateData.dischargedAt = toTimestampString(new Date());

      const updated = await db.orm.public.EmergencyVisit.where({ id: visit.id }).update(updateData as { status: EmergencyStatus });
      if (!updated) throw new NotFoundError('Emergency visit not found');

      return sendSuccess(res, updated, 'Status updated');
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/queue
   * Get active emergency queue sorted by priority
   */
  static async getQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const queue = await db.orm.public.EmergencyVisit
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .where((visit) => or(visit.status.eq(EmergencyStatus.TRIAGED), visit.status.eq(EmergencyStatus.WAITING)))
        .orderBy([
          (visit) => visit.priority.asc(),
          (visit) => visit.triageTime.asc(),
        ])
        .all();

      return sendSuccess(res, queue, 'Emergency queue retrieved');
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/stats
   */
  static async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const [totalToday, byPriority, byStatus] = await Promise.all([
        db.orm.public.EmergencyVisit.where((visit) =>
          and(visit.triageTime.gte(toTimestampString(today)), visit.triageTime.lt(toTimestampString(tomorrow)))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.EmergencyVisit
          .where((visit) =>
            and(visit.triageTime.gte(toTimestampString(today)), visit.triageTime.lt(toTimestampString(tomorrow)))
          )
          .groupBy('priority')
          .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.EmergencyVisit
          .where((visit) =>
            or(
              visit.status.eq(EmergencyStatus.TRIAGED),
              visit.status.eq(EmergencyStatus.WAITING),
              visit.status.eq(EmergencyStatus.IN_TREATMENT)
            )
          )
          .groupBy('status')
          .aggregate((aggregate) => ({ total: aggregate.count() })),
      ]);

      return sendSuccess(res, { totalToday: totalToday.total, byPriority, byStatus }, 'Emergency stats retrieved');
    } catch (error) { next(error); }
  }
}
