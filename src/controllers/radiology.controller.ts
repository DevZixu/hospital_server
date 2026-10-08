import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateRadiologyOrderNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { ImagingModality, RadiologyStatus } from '@prisma/client';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

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
        db.orm.public.Patient.where((patient) => or(patient.id.eq(patientId), patient.patientId.eq(patientId))).first(),
        db.orm.public.Doctor.where((doctor) => or(doctor.id.eq(doctorId), doctor.staff.some({ staffId: doctorId }))).first(),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const created = await db.orm.public.RadiologyOrder.create({
          orderNo: generateRadiologyOrderNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          modality,
          bodyPart,
          clinicalIndication,
          scheduledAt: scheduledAt ? toTimestampString(new Date(scheduledAt)) : undefined,
          price,
      });
      const order = await db.orm.public.RadiologyOrder
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .where({ id: created.id })
        .first();
      if (!order) throw new NotFoundError('Radiology order could not be created');

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

      const query = db.orm.public.RadiologyOrder.where((order) =>
        and(
          patientId ? order.patientId.eq(patientId as string) : all(),
          status ? order.status.eq(status as RadiologyStatus) : all(),
          modality ? order.modality.eq(modality as ImagingModality) : all()
        )
      );

      const [total, orders] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .orderBy((order) => order.createdAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, orders, 'Radiology orders retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /radiology/orders/:id
   */
  static async getOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const order = await db.orm.public.RadiologyOrder
        .include('patient')
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('medicalRecord', (record) => record.select('recordNo', 'chiefComplaint'))
        .where((record) => or(record.id.eq(id), record.orderNo.eq(id)))
        .first();
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

      const order = await db.orm.public.RadiologyOrder.where((record) => or(record.id.eq(id), record.orderNo.eq(id))).first();
      if (!order) throw new NotFoundError('Radiology order not found');

      const updated = await db.orm.public.RadiologyOrder.where({ id: order.id }).update({
          status: RadiologyStatus.COMPLETED,
          performedAt: toTimestampString(new Date()),
          performedBy: performedBy || req.user?.userId,
          imageUrls: imageUrls || [],
      });
      if (!updated) throw new NotFoundError('Radiology order not found');

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

      const order = await db.orm.public.RadiologyOrder.where((record) => or(record.id.eq(id), record.orderNo.eq(id))).first();
      if (!order) throw new NotFoundError('Radiology order not found');

      const updated = await db.orm.public.RadiologyOrder.where({ id: order.id }).update({
          status: RadiologyStatus.REPORTED,
          findings,
          impression,
          recommendation,
          radiologistId: radiologistId || req.user?.userId,
          reportedAt: toTimestampString(new Date()),
      });
      if (!updated) throw new NotFoundError('Radiology order not found');

      await logAudit(req.user?.userId, 'RADIOLOGY_REPORT', 'radiology_order', order.id);
      return sendSuccess(res, updated, 'Report submitted');
    } catch (error) { next(error); }
  }
}
