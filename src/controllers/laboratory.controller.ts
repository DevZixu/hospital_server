import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateLabOrderNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { LabTestStatus } from '@prisma/client';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findLabOrder = (id: string) =>
  db.orm.public.LabOrder.where((order) => or(order.id.eq(id), order.orderNo.eq(id))).first();

export class LaboratoryController {
  // ─── LAB TEST CATALOG ──────────────────────────────────────────────────

  static async createLabTest(req: Request, res: Response, next: NextFunction) {
    try {
      const labTest = await db.orm.public.LabTest.create(req.body);
      return sendCreated(res, labTest, 'Lab test created');
    } catch (error) { next(error); }
  }

  static async getLabTests(req: Request, res: Response, next: NextFunction) {
    try {
      const { search, category } = req.query;
      const pattern = search ? `%${String(search).replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const tests = await db.orm.public.LabTest.where((test) =>
        and(
          test.isActive.eq(true),
          category ? test.category.eq(category as string) : all(),
          pattern ? or(test.name.ilike(pattern), test.code.ilike(pattern)) : all()
        )
      ).orderBy((test) => test.name.asc()).all();
      return sendSuccess(res, tests, 'Lab tests retrieved');
    } catch (error) { next(error); }
  }

  static async updateLabTest(req: Request, res: Response, next: NextFunction) {
    try {
      const test = await db.orm.public.LabTest.where({ id: req.params.id }).update(req.body);
      if (!test) throw new NotFoundError('Lab test not found');
      return sendSuccess(res, test, 'Lab test updated');
    } catch (error) { next(error); }
  }

  // ─── LAB ORDERS ────────────────────────────────────────────────────────

  static async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId, doctorId, medicalRecordId, priority, clinicalNotes, testIds } = req.body;

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

      const labTests = await db.orm.public.LabTest.where((test) =>
        and(test.id.in(testIds), test.isActive.eq(true))
      ).all();

      if (labTests.length !== testIds.length) {
        throw new NotFoundError('One or more lab tests not found');
      }

      const created = await db.orm.public.LabOrder.create({
          orderNo: generateLabOrderNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          priority: priority || 'ROUTINE',
          clinicalNotes,
          items: (items) => items.create(labTests.map((test) => ({
              labTestId: test.id,
              status: LabTestStatus.ORDERED,
            }))),
        });
      const order = await db.orm.public.LabOrder
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('items', (items) => items.include('labTest'))
        .where({ id: created.id })
        .first();
      if (!order) throw new NotFoundError('Lab order not found');

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

      const query = db.orm.public.LabOrder.where((order) =>
        and(
          patientId ? order.patientId.eq(patientId as string) : all(),
          doctorId ? order.doctorId.eq(doctorId as string) : all(),
          priority ? order.priority.eq(priority as 'ROUTINE' | 'URGENT' | 'STAT') : all(),
          status ? order.items.some({ status: status as LabTestStatus }) : all()
        )
      );

      const [total, orders] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .include('items', (items) => items.include('labTest', (test) => test.select('name', 'code')))
          .orderBy((order) => order.orderedAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, orders, 'Lab orders retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  static async getOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const order = await db.orm.public.LabOrder
        .include('patient')
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('items', (items) => items.include('labTest'))
        .where((record) => or(record.id.eq(id), record.orderNo.eq(id)))
        .first();
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

      const item = await db.orm.public.LabOrderItem.where({ id: itemId, labOrderId: id }).first();
      if (!item) throw new NotFoundError('Lab order item not found');

      const updated = await db.orm.public.LabOrderItem.where({ id: itemId }).update({
          status: LabTestStatus.SAMPLE_COLLECTED,
          sampleCollectedAt: toTimestampString(new Date()),
          sampleCollectedBy: sampleCollectedBy || req.user?.userId,
      });
      if (!updated) throw new NotFoundError('Lab order item not found');

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

      const item = await db.orm.public.LabOrderItem.where({ id: itemId, labOrderId: id }).first();
      if (!item) throw new NotFoundError('Lab order item not found');

      const updated = await db.orm.public.LabOrderItem.include('labTest').where({ id: itemId }).update({
          status: LabTestStatus.COMPLETED,
          resultValue,
          resultUnit,
          referenceRange,
          isAbnormal,
          notes,
          reportedAt: toTimestampString(new Date()),
          reportedBy: req.user?.userId,
          technicianId: req.user?.userId,
      });
      if (!updated) throw new NotFoundError('Lab order item not found');

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
      const order = await db.orm.public.LabOrder
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId', 'dateOfBirth', 'gender', 'bloodGroup'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('items', (items) =>
          items.include('labTest', (test) => test.select('name', 'code', 'normalRange', 'unit', 'sampleType'))
        )
        .where((record) => or(record.id.eq(id), record.orderNo.eq(id)))
        .first();

      if (!order) throw new NotFoundError('Lab order not found');
      return sendSuccess(res, order, 'Lab report retrieved');
    } catch (error) { next(error); }
  }
}
