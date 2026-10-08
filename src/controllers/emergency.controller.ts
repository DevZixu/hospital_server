import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateEmergencyVisitNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { EmergencyStatus, EmergencyPriority } from '@prisma/client';

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
        const patient = await prisma.patient.findFirst({
          where: { OR: [{ id: patientId }, { patientId }] },
        });
        if (!patient) throw new NotFoundError('Patient not found');
        resolvedPatientId = patient.id;
      }

      const visit = await prisma.emergencyVisit.create({
        data: {
          visitNo: generateEmergencyVisitNo(),
          patientId: resolvedPatientId,
          walkinName, walkinAge, walkinGender,
          chiefComplaint,
          priority: priority || EmergencyPriority.P3_LESS_URGENT,
          triageNotes,
          vitalSystolic, vitalDiastolic, vitalHR, vitalTemp, vitalO2Sat, vitalRR,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
        },
      });

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

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (date) {
        const start = new Date(date as string);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        where.triageTime = { gte: start, lt: end };
      }

      const [total, visits] = await Promise.all([
        prisma.emergencyVisit.count({ where }),
        prisma.emergencyVisit.findMany({
          where, skip, take: limit, orderBy: { triageTime: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true, phone: true } },
          },
        }),
      ]);

      return sendSuccess(res, visits, 'Emergency visits retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/visits/:id
   */
  static async getVisit(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const visit = await prisma.emergencyVisit.findFirst({
        where: { OR: [{ id }, { visitNo: id }] },
        include: {
          patient: true,
        },
      });
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

      const visit = await prisma.emergencyVisit.findFirst({
        where: { OR: [{ id }, { visitNo: id }] },
      });
      if (!visit) throw new NotFoundError('Emergency visit not found');

      const updated = await prisma.emergencyVisit.update({
        where: { id: visit.id },
        data: {
          assignedDoctorId: doctorId,
          roomNo,
          status: EmergencyStatus.IN_TREATMENT,
        },
      });

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

      const visit = await prisma.emergencyVisit.findFirst({
        where: { OR: [{ id }, { visitNo: id }] },
      });
      if (!visit) throw new NotFoundError('Emergency visit not found');

      const updateData: Record<string, unknown> = { status };
      if (treatmentNotes) updateData.treatmentNotes = treatmentNotes;
      if (dispositionNotes) updateData.dispositionNotes = dispositionNotes;
      if (status === EmergencyStatus.DISCHARGED) updateData.dischargedAt = new Date();

      const updated = await prisma.emergencyVisit.update({
        where: { id: visit.id },
        data: updateData,
      });

      return sendSuccess(res, updated, 'Status updated');
    } catch (error) { next(error); }
  }

  /**
   * GET /emergency/queue
   * Get active emergency queue sorted by priority
   */
  static async getQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const queue = await prisma.emergencyVisit.findMany({
        where: {
          status: {
            in: [EmergencyStatus.TRIAGED, EmergencyStatus.WAITING],
          },
        },
        orderBy: [
          { priority: 'asc' }, // P1 first
          { triageTime: 'asc' }, // FIFO within same priority
        ],
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
        },
      });

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

      const [totalToday, byPriority, byStatus] = await Promise.all([
        prisma.emergencyVisit.count({ where: { triageTime: { gte: today } } }),
        prisma.emergencyVisit.groupBy({
          by: ['priority'],
          where: { triageTime: { gte: today } },
          _count: { id: true },
        }),
        prisma.emergencyVisit.groupBy({
          by: ['status'],
          where: { status: { in: [EmergencyStatus.TRIAGED, EmergencyStatus.WAITING, EmergencyStatus.IN_TREATMENT] } },
          _count: { id: true },
        }),
      ]);

      return sendSuccess(res, { totalToday, byPriority, byStatus }, 'Emergency stats retrieved');
    } catch (error) { next(error); }
  }
}
