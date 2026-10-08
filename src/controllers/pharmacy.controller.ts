import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generatePrescriptionNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { PrescriptionStatus } from '@prisma/client';

export class PharmacyController {
  // ─── MEDICATIONS ───────────────────────────────────────────────────────

  static async createMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const medication = await prisma.medication.create({ data: req.body });
      return sendCreated(res, medication, 'Medication created');
    } catch (error) { next(error); }
  }

  static async getMedications(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { search, category, isActive } = req.query;

      const where: Record<string, unknown> = {};
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { genericName: { contains: search as string, mode: 'insensitive' } },
          { brand: { contains: search as string, mode: 'insensitive' } },
        ];
      }
      if (category) where.category = category;
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const [total, medications] = await Promise.all([
        prisma.medication.count({ where }),
        prisma.medication.findMany({
          where, skip, take: limit, orderBy: { name: 'asc' },
          include: { stockItems: { where: { quantity: { gt: 0 } } } },
        }),
      ]);

      return sendSuccess(res, medications, 'Medications retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  static async getMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const med = await prisma.medication.findUnique({
        where: { id: req.params.id },
        include: { stockItems: true },
      });
      if (!med) throw new NotFoundError('Medication not found');
      return sendSuccess(res, med);
    } catch (error) { next(error); }
  }

  static async updateMedication(req: Request, res: Response, next: NextFunction) {
    try {
      const med = await prisma.medication.update({
        where: { id: req.params.id },
        data: req.body,
      });
      return sendSuccess(res, med, 'Medication updated');
    } catch (error) { next(error); }
  }

  // ─── PHARMACY STOCK ────────────────────────────────────────────────────

  static async addStock(req: Request, res: Response, next: NextFunction) {
    try {
      const { medicationId, batchNumber, quantity, sellingPrice, expiryDate, ...rest } = req.body;

      const med = await prisma.medication.findUnique({ where: { id: medicationId } });
      if (!med) throw new NotFoundError('Medication not found');

      const stock = await prisma.pharmacyStock.create({
        data: {
          medicationId, batchNumber, quantity, sellingPrice,
          expiryDate: new Date(expiryDate), ...rest,
        },
        include: { medication: true },
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

      const where: Record<string, unknown> = {};
      if (lowStock === 'true') {
        // Only items at or below reorder level
        where.quantity = { lte: prisma.pharmacyStock.fields.reorderLevel };
      }
      if (expiringSoon === 'true') {
        where.expiryDate = { lte: thirtyDaysFromNow };
      }

      const [total, stock] = await Promise.all([
        prisma.pharmacyStock.count({ where }),
        prisma.pharmacyStock.findMany({
          where, skip, take: limit,
          orderBy: { expiryDate: 'asc' },
          include: { medication: { select: { name: true, genericName: true, category: true } } },
        }),
      ]);

      return sendSuccess(res, stock, 'Stock retrieved', 200, buildPaginationMeta(total, page, limit));
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
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findFirst({ where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const prescription = await prisma.prescription.create({
        data: {
          prescriptionNo: generatePrescriptionNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          medicalRecordId,
          notes,
          isRefillable: isRefillable || false,
          validUntil: validUntil ? new Date(validUntil) : undefined,
          items: {
            create: items.map((item: {
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
            })),
          },
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          items: { include: { medication: true } },
        },
      });

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

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (doctorId) where.doctorId = doctorId;
      if (status) where.status = status;

      const [total, prescriptions] = await Promise.all([
        prisma.prescription.count({ where }),
        prisma.prescription.findMany({
          where, skip, take: limit, orderBy: { prescribedAt: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
            items: { include: { medication: { select: { name: true, genericName: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, prescriptions, 'Prescriptions retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  static async getPrescription(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const prescription = await prisma.prescription.findFirst({
        where: { OR: [{ id }, { prescriptionNo: id }] },
        include: {
          patient: true,
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          items: { include: { medication: true } },
        },
      });
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
      const prescription = await prisma.prescription.findFirst({
        where: { OR: [{ id }, { prescriptionNo: id }] },
        include: { items: { include: { medication: { include: { stockItems: true } } } } },
      });

      if (!prescription) throw new NotFoundError('Prescription not found');
      if (prescription.status === PrescriptionStatus.DISPENSED) {
        throw new Error('Prescription already dispensed');
      }

      // Check stock availability for each item
      for (const item of prescription.items) {
        const totalStock = item.medication.stockItems.reduce(
          (acc, s) => acc + s.quantity, 0
        );
        if (totalStock < item.quantity) {
          throw new Error(`Insufficient stock for ${item.medication.name}`);
        }
      }

      // Update prescription status
      const updated = await prisma.prescription.update({
        where: { id: prescription.id },
        data: {
          status: PrescriptionStatus.DISPENSED,
          dispensedAt: new Date(),
          dispensedBy: req.user?.userId,
          items: {
            updateMany: {
              where: { prescriptionId: prescription.id },
              data: {},
            },
          },
        },
        include: {
          patient: { select: { firstName: true, lastName: true } },
          items: { include: { medication: { select: { name: true } } } },
        },
      });

      await logAudit(req.user?.userId, 'DISPENSE', 'prescription', prescription.id);
      return sendSuccess(res, updated, 'Prescription dispensed successfully');
    } catch (error) { next(error); }
  }
}
