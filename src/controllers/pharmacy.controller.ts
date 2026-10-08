import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { AppError, NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generatePrescriptionNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { PrescriptionStatus } from '../prisma/enums';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findPrescription = (id: string) =>
  db.orm.public.Prescription.where((prescription) =>
    or(prescription.id.eq(id), prescription.prescriptionNo.eq(id))
  ).first();

export class PharmacyController {
  // ─── MEDICATIONS ───────────────────────────────────────────────────────

  static async createMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const medication = await db.orm.public.Medication.create(req.body);
      return sendCreated(res, medication, 'Medication created');
    } catch (error) { next(error); }
  }

  static async getMedications(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { search, category, isActive } = req.query;

      const pattern = search ? `%${String(search).replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const query = db.orm.public.Medication.where((medication) =>
        and(
          pattern
            ? or(
                medication.name.ilike(pattern),
                medication.genericName.ilike(pattern),
                medication.brand.ilike(pattern)
              )
            : all(),
          category ? medication.category.eq(category as string) : all(),
          isActive !== undefined ? medication.isActive.eq(isActive === 'true') : all()
        )
      );

      const [total, medications] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('stockItems', (stock) => stock.where((item) => item.quantity.gt(0)))
          .orderBy((medication) => medication.name.asc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, medications, 'Medications retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  static async getMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const med = await db.orm.public.Medication.include('stockItems').where({ id: req.params.id }).first();
      if (!med) throw new NotFoundError('Medication not found');
      return sendSuccess(res, med);
    } catch (error) { next(error); }
  }

  static async updateMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const med = await db.orm.public.Medication.where({ id: req.params.id }).update(req.body);
      if (!med) throw new NotFoundError('Medication not found');
      return sendSuccess(res, med, 'Medication updated');
    } catch (error) { next(error); }
  }

  // ─── PHARMACY STOCK ────────────────────────────────────────────────────

  static async addStock(req: Request, res: Response, next: NextFunction) {
    try {
      const { medicationId, batchNumber, quantity, sellingPrice, expiryDate, ...rest } = req.body;

      const med = await db.orm.public.Medication.where({ id: medicationId }).first();
      if (!med) throw new NotFoundError('Medication not found');

      const stock = await db.orm.public.PharmacyStock.include('medication').create({
        medicationId, batchNumber, quantity, sellingPrice,
        expiryDate: toTimestampString(new Date(expiryDate)), ...rest,
      });
      return sendCreated(res, stock, 'Stock added');
    } catch (error) { next(error); }
  }

  static async getStock(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { lowStock, expiringSoon } = req.query;

      const now = new Date();
      const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const query = db.orm.public.PharmacyStock.where((stock) =>
        and(
          lowStock === 'true' ? stock.quantity.lte(stock.reorderLevel) : all(),
          expiringSoon === 'true' ? stock.expiryDate.lte(toTimestampString(thirtyDaysFromNow)) : all()
        )
      );

      const [total, stock] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('medication', (medication) => medication.select('name', 'genericName', 'category'))
          .orderBy((item) => item.expiryDate.asc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, stock, 'Stock retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  // ─── PRESCRIPTIONS ─────────────────────────────────────────────────────

  static async createPrescription(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, doctorId, medicalRecordId, notes, isRefillable,
        validUntil, items,
      } = req.body;

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

      const created = await db.orm.public.Prescription.create({
          prescriptionNo: generatePrescriptionNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          notes,
          isRefillable: isRefillable || false,
          validUntil: validUntil ? toTimestampString(new Date(validUntil)) : undefined,
          items: (prescriptionItems) => prescriptionItems.create(items.map((item: {
              medicationId: string; dosage: string; route: string;
              frequency: string; duration?: number; durationUnit?: string;
              quantity: number; instructions?: string;
            }) => ({
              medicationId: item.medicationId,
              dosage: item.dosage,
              route: item.route,
              frequency: item.frequency,
              duration: item.duration,
              durationUnit: item.durationUnit,
              quantity: item.quantity,
              instructions: item.instructions,
            }))),
      });
      const prescription = await db.orm.public.Prescription
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('items', (items) => items.include('medication'))
        .where({ id: created.id })
        .first();
      if (!prescription) throw new NotFoundError('Prescription could not be created');

      await logAudit(req.user?.userId, 'PRESCRIBE', 'prescription', prescription.id, null, prescription);
      return sendCreated(res, prescription, 'Prescription created');
    } catch (error) { next(error); }
  }

  static async getPrescriptions(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, doctorId, status } = req.query;

      const query = db.orm.public.Prescription.where((prescription) =>
        and(
          patientId ? prescription.patientId.eq(patientId as string) : all(),
          doctorId ? prescription.doctorId.eq(doctorId as string) : all(),
          status ? prescription.status.eq(status as PrescriptionStatus) : all()
        )
      );

      const [total, prescriptions] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .include('items', (items) => items.include('medication', (medication) => medication.select('name', 'genericName')))
          .orderBy((prescription) => prescription.prescribedAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, prescriptions, 'Prescriptions retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  static async getPrescription(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const prescription = await db.orm.public.Prescription
        .include('patient')
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('items', (items) => items.include('medication'))
        .where((record) => or(record.id.eq(id), record.prescriptionNo.eq(id)))
        .first();
      if (!prescription) throw new NotFoundError('Prescription not found');
      return sendSuccess(res, prescription);
    } catch (error) { next(error); }
  }

  /**
   * POST /pharmacy/prescriptions/:id/dispense
   * Dispense a prescription (pharmacist action)
   */
  static async dispensePrescription(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const prescription = await db.orm.public.Prescription
        .include('items', (items) => items.include('medication', (medication) => medication.include('stockItems')))
        .where((record) => or(record.id.eq(id), record.prescriptionNo.eq(id)))
        .first();

      if (!prescription) throw new NotFoundError('Prescription not found');
      if (prescription.status === PrescriptionStatus.DISPENSED) {
        throw new AppError('Prescription already dispensed', 409);
      }

      await db.transaction(async (tx) => {
        for (const item of prescription.items) {
          let needed = item.quantity - item.dispensedQty;
          const stockItems = await tx.orm.public.PharmacyStock
            .where((stock) =>
              and(
                stock.medicationId.eq(item.medicationId),
                stock.quantity.gt(0),
                stock.expiryDate.gte(toTimestampString(new Date()))
              )
            )
            .orderBy((stock) => stock.expiryDate.asc())
            .all();

          for (const stock of stockItems) {
            if (needed <= 0) break;
            const dispensed = Math.min(needed, stock.quantity);
            const updatedStock = await tx.orm.public.PharmacyStock.where({
              id: stock.id,
              quantity: stock.quantity,
            }).update({
              quantity: stock.quantity - dispensed,
            });
            if (!updatedStock) throw new AppError('Stock changed while dispensing; retry the operation', 409);
            needed -= dispensed;
          }

          if (needed > 0) {
            throw new AppError(`Insufficient unexpired stock for ${item.medication?.name || 'medication'}`, 409);
          }
          await tx.orm.public.PrescriptionItem.where({ id: item.id }).update({
            dispensedQty: item.quantity,
          });
        }

        await tx.orm.public.Prescription.where({ id: prescription.id }).update({
          status: PrescriptionStatus.DISPENSED,
          dispensedAt: toTimestampString(new Date()),
          dispensedBy: req.user?.userId,
        });
      });

      const updated = await db.orm.public.Prescription
        .include('patient', (patient) => patient.select('firstName', 'lastName'))
        .include('items', (items) => items.include('medication', (medication) => medication.select('name')))
        .where({ id: prescription.id })
        .first();
      if (!updated) throw new NotFoundError('Prescription not found');

      await logAudit(req.user?.userId, 'DISPENSE', 'prescription', prescription.id);
      return sendSuccess(res, updated, 'Prescription dispensed successfully');
    } catch (error) { next(error); }
  }
}
