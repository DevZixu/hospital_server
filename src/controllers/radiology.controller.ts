import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateRadiologyOrderNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { RadiologyStatus } from '@prisma/client';

export class RadiologyController {
  /**
   * POST /radiology/orders
   */
  static async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, doctorId, medicalRecordId, modality, bodyPart,
        clinicalIndication, scheduledAt, price,
      } = req.body;

      const [patient, doctor] = await Promise.all([
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findFirst({ where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const order = await prisma.radiologyOrder.create({
        data: {
          orderNo: generateRadiologyOrderNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          modality,
          bodyPart,
          clinicalIndication,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          price,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
        },
      });

      await logAudit(req.user?.userId, 'ORDER_RADIOLOGY', 'radiology_order', order.id, null, order);
      return sendCreated(res, order, 'Radiology order created');
    } catch (error) { next(error); }
  }

  /**
   * GET /radiology/orders
   */
  static async getOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, status, modality } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.status = status;
      if (modality) where.modality = modality;

      const [total, orders] = await Promise.all([
        prisma.radiologyOrder.count({ where }),
        prisma.radiologyOrder.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, orders, 'Radiology orders retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /radiology/orders/:id
   */
  static async getOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const order = await prisma.radiologyOrder.findFirst({
        where: { OR: [{ id }, { orderNo: id }] },
        include: {
          patient: true,
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          medicalRecord: { select: { recordNo: true, chiefComplaint: true } },
        },
      });
      if (!order) throw new NotFoundError('Radiology order not found');
      return sendSuccess(res, order);
    } catch (error) { next(error); }
  }

  /**
   * PATCH /radiology/orders/:id/perform
   */
  static async markPerformed(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { performedBy, imageUrls } = req.body;

      const order = await prisma.radiologyOrder.findFirst({
        where: { OR: [{ id }, { orderNo: id }] },
      });
      if (!order) throw new NotFoundError('Radiology order not found');

      const updated = await prisma.radiologyOrder.update({
        where: { id: order.id },
        data: {
          status: RadiologyStatus.COMPLETED,
          performedAt: new Date(),
          performedBy: performedBy || req.user?.userId,
          imageUrls: imageUrls || [],
        },
      });

      return sendSuccess(res, updated, 'Marked as performed');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /radiology/orders/:id/report
   */
  static async submitReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { findings, impression, recommendation, radiologistId } = req.body;

      const order = await prisma.radiologyOrder.findFirst({
        where: { OR: [{ id }, { orderNo: id }] },
      });
      if (!order) throw new NotFoundError('Radiology order not found');

      const updated = await prisma.radiologyOrder.update({
        where: { id: order.id },
        data: {
          status: RadiologyStatus.REPORTED,
          findings,
          impression,
          recommendation,
          radiologistId: radiologistId || req.user?.userId,
          reportedAt: new Date(),
        },
      });

      await logAudit(req.user?.userId, 'RADIOLOGY_REPORT', 'radiology_order', order.id);
      return sendSuccess(res, updated, 'Report submitted');
    } catch (error) { next(error); }
  }
}
