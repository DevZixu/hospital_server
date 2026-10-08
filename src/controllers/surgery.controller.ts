import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateSurgeryNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { SurgeryStatus } from '@prisma/client';

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
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findUnique({ where: { id: leadSurgeonId } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Lead surgeon not found');

      const surgery = await prisma.surgery.create({
        data: {
          surgeryNo: generateSurgeryNo(),
          patientId: patient.id,
          admissionId,
          leadSurgeonId: doctor.id,
          procedureName,
          icdProcedureCode,
          priority: priority || 'ELECTIVE',
          operatingRoom,
          scheduledAt: new Date(scheduledAt),
          anesthesiaType,
          anesthesiologist,
          preOpDiagnosis,
          estimatedCost,
          notes,
          staff: staffMembers
            ? {
                create: staffMembers.map((s: { staffId: string; role: string }) => ({
                  staffId: s.staffId,
                  role: s.role,
                })),
              }
            : undefined,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          leadSurgeon: { include: { staff: { select: { firstName: true, lastName: true } } } },
          staff: { include: { staff: { select: { firstName: true, lastName: true } } } },
        },
      });

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

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (date) {
        const start = new Date(date as string);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        where.scheduledAt = { gte: start, lt: end };
      }

      const [total, surgeries] = await Promise.all([
        prisma.surgery.count({ where }),
        prisma.surgery.findMany({
          where, skip, take: limit, orderBy: { scheduledAt: 'asc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            leadSurgeon: { include: { staff: { select: { firstName: true, lastName: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, surgeries, 'Surgeries retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /surgery/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const surgery = await prisma.surgery.findFirst({
        where: { OR: [{ id }, { surgeryNo: id }] },
        include: {
          patient: true,
          leadSurgeon: { include: { staff: true, specialization: true } },
          admission: true,
          staff: { include: { staff: { select: { firstName: true, lastName: true, position: true } } } },
        },
      });
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
      const surgery = await prisma.surgery.findFirst({
        where: { OR: [{ id }, { surgeryNo: id }] },
      });
      if (!surgery) throw new NotFoundError('Surgery not found');

      const updated = await prisma.surgery.update({
        where: { id: surgery.id },
        data: { status: SurgeryStatus.IN_PROGRESS, startedAt: new Date() },
      });

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

      const surgery = await prisma.surgery.findFirst({
        where: { OR: [{ id }, { surgeryNo: id }] },
      });
      if (!surgery) throw new NotFoundError('Surgery not found');

      const endedAt = new Date();
      const duration = surgery.startedAt
        ? Math.floor((endedAt.getTime() - surgery.startedAt.getTime()) / 60000)
        : undefined;

      const updated = await prisma.surgery.update({
        where: { id: surgery.id },
        data: {
          status: SurgeryStatus.COMPLETED,
          endedAt,
          duration,
          postOpDiagnosis,
          findings,
          complications,
          notes,
        },
      });

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

      const surgery = await prisma.surgery.findFirst({
        where: { OR: [{ id }, { surgeryNo: id }] },
      });
      if (!surgery) throw new NotFoundError('Surgery not found');

      const updated = await prisma.surgery.update({
        where: { id: surgery.id },
        data: { status: SurgeryStatus.CANCELLED, notes },
      });

      return sendSuccess(res, updated, 'Surgery cancelled');
    } catch (error) { next(error); }
  }
}
