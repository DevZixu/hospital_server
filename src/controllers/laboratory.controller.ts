import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateLabOrderNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { LabTestStatus } from '@prisma/client';

export class LaboratoryController {
  // ─── LAB TEST CATALOG ──────────────────────────────────────────────────

  static async createLabTest(req: Request, res: Response, next: NextFunction) {
    try {
      const labTest = await prisma.labTest.create({ data: req.body });
      return sendCreated(res, labTest, 'Lab test created');
    } catch (error) { next(error); }
  }

  static async getLabTests(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, category } = req.query;
      const where: Record<string, unknown> = { isActive: true };
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { code: { contains: search as string, mode: 'insensitive' } },
        ];
      }
      if (category) where.category = category;

      const tests = await prisma.labTest.findMany({
        where, orderBy: { name: 'asc' },
      });
      return sendSuccess(res, tests, 'Lab tests retrieved');
    } catch (error) { next(error); }
  }

  static async updateLabTest(req: Request, res: Response, next: NextFunction) {
    try {
      const test = await prisma.labTest.update({
        where: { id: req.params.id },
        data: req.body,
      });
      return sendSuccess(res, test, 'Lab test updated');
    } catch (error) { next(error); }
  }

  // ─── LAB ORDERS ────────────────────────────────────────────────────────

  static async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId, doctorId, medicalRecordId, priority, clinicalNotes, testIds } = req.body;

      const [patient, doctor] = await Promise.all([
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findFirst({ where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const labTests = await prisma.labTest.findMany({
        where: { id: { in: testIds }, isActive: true },
      });

      if (labTests.length !== testIds.length) {
        throw new NotFoundError('One or more lab tests not found');
      }

      const order = await prisma.labOrder.create({
        data: {
          orderNo: generateLabOrderNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          priority: priority || 'ROUTINE',
          clinicalNotes,
          items: {
            create: labTests.map((test) => ({
              labTestId: test.id,
              status: LabTestStatus.ORDERED,
            })),
          },
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          items: { include: { labTest: true } },
        },
      });

      await logAudit(req.user?.userId, 'ORDER_LAB', 'lab_order', order.id, null, order);
      return sendCreated(res, order, 'Lab order created');
    } catch (error) { next(error); }
  }

  static async getOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, doctorId, priority, status } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (doctorId) where.doctorId = doctorId;
      if (priority) where.priority = priority;
      if (status) where.items = { some: { status } };

      const [total, orders] = await Promise.all([
        prisma.labOrder.count({ where }),
        prisma.labOrder.findMany({
          where, skip, take: limit, orderBy: { orderedAt: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
            items: { include: { labTest: { select: { name: true, code: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, orders, 'Lab orders retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  static async getOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const order = await prisma.labOrder.findFirst({
        where: { OR: [{ id }, { orderNo: id }] },
        include: {
          patient: true,
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          items: { include: { labTest: true } },
        },
      });
      if (!order) throw new NotFoundError('Lab order not found');
      return sendSuccess(res, order);
    } catch (error) { next(error); }
  }

  /**
   * PATCH /lab/orders/:id/items/:itemId/collect
   * Mark sample as collected
   */
  static async collectSample(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, itemId } = req.params;
      const { sampleCollectedBy } = req.body;

      const item = await prisma.labOrderItem.findFirst({
        where: { id: itemId, labOrderId: id },
      });
      if (!item) throw new NotFoundError('Lab order item not found');

      const updated = await prisma.labOrderItem.update({
        where: { id: itemId },
        data: {
          status: LabTestStatus.SAMPLE_COLLECTED,
          sampleCollectedAt: new Date(),
          sampleCollectedBy: sampleCollectedBy || req.user?.userId,
        },
      });

      return sendSuccess(res, updated, 'Sample collected');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /lab/orders/:id/items/:itemId/result
   * Enter lab result
   */
  static async enterResult(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, itemId } = req.params;
      const { resultValue, resultUnit, referenceRange, isAbnormal, notes } = req.body;

      const item = await prisma.labOrderItem.findFirst({
        where: { id: itemId, labOrderId: id },
      });
      if (!item) throw new NotFoundError('Lab order item not found');

      const updated = await prisma.labOrderItem.update({
        where: { id: itemId },
        data: {
          status: LabTestStatus.COMPLETED,
          resultValue,
          resultUnit,
          referenceRange,
          isAbnormal,
          notes,
          reportedAt: new Date(),
          reportedBy: req.user?.userId,
          technicianId: req.user?.userId,
        },
        include: { labTest: true },
      });

      await logAudit(req.user?.userId, 'ENTER_RESULT', 'lab_order_item', itemId);
      return sendSuccess(res, updated, 'Result entered');
    } catch (error) { next(error); }
  }

  /**
   * GET /lab/orders/:id/report
   * Get full lab report
   */
  static async getReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const order = await prisma.labOrder.findFirst({
        where: { OR: [{ id }, { orderNo: id }] },
        include: {
          patient: {
            select: {
              firstName: true, lastName: true, patientId: true,
              dateOfBirth: true, gender: true, bloodGroup: true,
            },
          },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          items: {
            include: {
              labTest: {
                select: { name: true, code: true, normalRange: true, unit: true, sampleType: true },
              },
            },
          },
        },
      });

      if (!order) throw new NotFoundError('Lab order not found');
      return sendSuccess(res, order, 'Lab report retrieved');
    } catch (error) { next(error); }
  }
}
