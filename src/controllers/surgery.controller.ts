import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateSurgeryNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { SurgeryStatus } from '../prisma/enums';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findSurgery = (id: string) =>
  db.orm.public.Surgery.where((surgery) => or(surgery.id.eq(id), surgery.surgeryNo.eq(id))).first();

export class SurgeryController {
  /**
   * POST /surgery
   */
  static async schedule(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, admissionId, leadSurgeonId, procedureName,
        icdProcedureCode, priority, operatingRoom, scheduledAt,
        anesthesiaType, anesthesiologist, preOpDiagnosis, estimatedCost,
        notes, staffMembers,
      } = req.body;

      const [patient, doctor] = await Promise.all([
        db.orm.public.Patient.where((patient) => or(patient.id.eq(patientId), patient.patientId.eq(patientId))).first(),
        db.orm.public.Doctor.where({ id: leadSurgeonId }).first(),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Lead surgeon not found');

      const created = await db.orm.public.Surgery.create({
          surgeryNo: generateSurgeryNo(),
          patientId: patient.id,
          admissionId,
          leadSurgeonId: doctor.id,
          procedureName,
          icdProcedureCode,
          priority: priority || 'ELECTIVE',
          operatingRoom,
          scheduledAt: toTimestampString(new Date(scheduledAt)),
          anesthesiaType,
          anesthesiologist,
          preOpDiagnosis,
          estimatedCost,
          notes,
          staff: staffMembers
            ? (members) => members.create(staffMembers.map((s: { staffId: string; role: string }) => ({
                  staffId: s.staffId,
                  role: s.role,
                })))
            : undefined,
      });
      const surgery = await db.orm.public.Surgery
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .include('leadSurgeon', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('staff', (members) => members.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .where({ id: created.id })
        .first();
      if (!surgery) throw new NotFoundError('Surgery could not be scheduled');

      await logAudit(req.user?.userId, 'SCHEDULE_SURGERY', 'surgery', surgery.id, null, surgery);
      return sendCreated(res, surgery, 'Surgery scheduled');
    } catch (error) { next(error); }
  }

  /**
   * GET /surgery
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, status, priority, date } = req.query;

      let start: Date | undefined;
      let end: Date | undefined;
      if (date) {
        start = new Date(date as string);
        end = new Date(start);
        end.setDate(end.getDate() + 1);
      }
      const query = db.orm.public.Surgery.where((surgery) =>
        and(
          patientId ? surgery.patientId.eq(patientId as string) : all(),
          status ? surgery.status.eq(status as SurgeryStatus) : all(),
          priority ? surgery.priority.eq(priority as 'ELECTIVE' | 'URGENT' | 'EMERGENCY') : all(),
          start && end
            ? and(surgery.scheduledAt.gte(toTimestampString(start)), surgery.scheduledAt.lt(toTimestampString(end)))
            : all()
        )
      );

      const [total, surgeries] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('leadSurgeon', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .orderBy((surgery) => surgery.scheduledAt.asc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, surgeries, 'Surgeries retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /surgery/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const surgery = await db.orm.public.Surgery
        .include('patient')
        .include('leadSurgeon', (doctor) => doctor.include('staff').include('specialization'))
        .include('admission')
        .include('staff', (members) => members.include('staff', (staff) => staff.select('firstName', 'lastName', 'position')))
        .where((record) => or(record.id.eq(id), record.surgeryNo.eq(id)))
        .first();
      if (!surgery) throw new NotFoundError('Surgery not found');
      return sendSuccess(res, surgery);
    } catch (error) { next(error); }
  }

  /**
   * PATCH /surgery/:id/start
   */
  static async startSurgery(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const surgery = await findSurgery(id);
      if (!surgery) throw new NotFoundError('Surgery not found');

      const updated = await db.orm.public.Surgery.where({ id: surgery.id }).update({
        status: SurgeryStatus.IN_PROGRESS,
        startedAt: toTimestampString(new Date()),
      });
      if (!updated) throw new NotFoundError('Surgery not found');

      return sendSuccess(res, updated, 'Surgery started');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /surgery/:id/complete
   */
  static async completeSurgery(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { postOpDiagnosis, findings, complications, notes } = req.body;

      const surgery = await findSurgery(id);
      if (!surgery) throw new NotFoundError('Surgery not found');

      const endedAt = new Date();
      const duration = surgery.startedAt
        ? Math.floor((endedAt.getTime() - new Date(surgery.startedAt).getTime()) / 60000)
        : undefined;

      const updated = await db.orm.public.Surgery.where({ id: surgery.id }).update({
          status: SurgeryStatus.COMPLETED,
          endedAt: toTimestampString(endedAt),
          duration,
          postOpDiagnosis,
          findings,
          complications,
          notes,
      });
      if (!updated) throw new NotFoundError('Surgery not found');

      await logAudit(req.user?.userId, 'COMPLETE_SURGERY', 'surgery', surgery.id);
      return sendSuccess(res, updated, 'Surgery completed');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /surgery/:id/cancel
   */
  static async cancelSurgery(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { notes } = req.body;

      const surgery = await findSurgery(id);
      if (!surgery) throw new NotFoundError('Surgery not found');

      const updated = await db.orm.public.Surgery.where({ id: surgery.id }).update({
        status: SurgeryStatus.CANCELLED,
        notes,
      });
      if (!updated) throw new NotFoundError('Surgery not found');

      return sendSuccess(res, updated, 'Surgery cancelled');
    } catch (error) { next(error); }
  }
}
