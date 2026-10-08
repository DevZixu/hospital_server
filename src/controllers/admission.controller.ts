import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError, AppError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateAdmissionNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { BedStatus, AdmissionStatus } from '@prisma/client';

export class AdmissionController {
  /**
   * POST /admissions
   */
  static async admit(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, bedId, admittingDoctorId, admissionReason,
        expectedDischarge, referralSource,
      } = req.body;

      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      // Check for existing active admission
      const activeAdmission = await prisma.admission.findFirst({
        where: {
          patientId: patient.id,
          status: AdmissionStatus.ADMITTED,
        },
      });
      if (activeAdmission) {
        throw new AppError('Patient already has an active admission', 409);
      }

      // Assign bed if specified
      let bed = null;
      if (bedId) {
        bed = await prisma.bed.findUnique({ where: { id: bedId } });
        if (!bed) throw new NotFoundError('Bed not found');
        if (bed.status !== BedStatus.AVAILABLE) {
          throw new AppError('Bed is not available', 409);
        }
        await prisma.bed.update({ where: { id: bedId }, data: { status: BedStatus.OCCUPIED } });
      }

      const admission = await prisma.admission.create({
        data: {
          admissionNo: generateAdmissionNo(),
          patientId: patient.id,
          bedId,
          admittingDoctorId,
          admissionReason,
          expectedDischarge: expectedDischarge ? new Date(expectedDischarge) : undefined,
          referralSource,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          bed: { include: { ward: true } },
        },
      });

      await logAudit(req.user?.userId, 'ADMIT', 'admission', admission.id, null, admission);
      return sendCreated(res, admission, 'Patient admitted successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /admissions
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, status, wardId } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.status = status;
      if (wardId) where.bed = { wardId };

      const [total, admissions] = await Promise.all([
        prisma.admission.count({ where }),
        prisma.admission.findMany({
          where,
          skip,
          take: limit,
          orderBy: { admissionDate: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true, phone: true } },
            bed: { include: { ward: { select: { name: true, wardCode: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, admissions, 'Admissions retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /admissions/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const admission = await prisma.admission.findFirst({
        where: { OR: [{ id }, { admissionNo: id }] },
        include: {
          patient: true,
          bed: { include: { ward: { include: { department: true } } } },
          medicalRecords: {
            include: { diagnoses: true, doctor: { include: { staff: { select: { firstName: true, lastName: true } } } } },
            orderBy: { visitDate: 'desc' },
          },
          vitalSigns: { orderBy: { recordedAt: 'desc' }, take: 5 },
          surgeries: true,
        },
      });

      if (!admission) throw new NotFoundError('Admission not found');
      return sendSuccess(res, admission);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /admissions/:id/discharge
   */
  static async discharge(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { dischargeNotes } = req.body;

      const admission = await prisma.admission.findFirst({
        where: { OR: [{ id }, { admissionNo: id }] },
        include: { bed: true },
      });
      if (!admission) throw new NotFoundError('Admission not found');
      if (admission.status === AdmissionStatus.DISCHARGED) {
        throw new AppError('Patient already discharged', 400);
      }

      await prisma.$transaction(async (tx) => {
        await tx.admission.update({
          where: { id: admission.id },
          data: {
            status: AdmissionStatus.DISCHARGED,
            dischargeDate: new Date(),
            dischargeNotes,
          },
        });

        // Free up the bed
        if (admission.bedId) {
          await tx.bed.update({
            where: { id: admission.bedId },
            data: { status: BedStatus.AVAILABLE },
          });
        }
      });

      await logAudit(req.user?.userId, 'DISCHARGE', 'admission', admission.id);
      return sendSuccess(res, null, 'Patient discharged successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /admissions/:id/transfer
   */
  static async transfer(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { newBedId, transferNotes } = req.body;

      const admission = await prisma.admission.findFirst({
        where: { OR: [{ id }, { admissionNo: id }] },
        include: { bed: true },
      });
      if (!admission) throw new NotFoundError('Admission not found');
      if (admission.status !== AdmissionStatus.ADMITTED) {
        throw new AppError('Patient is not currently admitted', 400);
      }

      const newBed = await prisma.bed.findUnique({ where: { id: newBedId } });
      if (!newBed) throw new NotFoundError('New bed not found');
      if (newBed.status !== BedStatus.AVAILABLE) {
        throw new AppError('New bed is not available', 409);
      }

      await prisma.$transaction(async (tx) => {
        // Free old bed
        if (admission.bedId) {
          await tx.bed.update({
            where: { id: admission.bedId },
            data: { status: BedStatus.AVAILABLE },
          });
        }
        // Occupy new bed
        await tx.bed.update({
          where: { id: newBedId },
          data: { status: BedStatus.OCCUPIED },
        });
        // Update admission
        await tx.admission.update({
          where: { id: admission.id },
          data: { bedId: newBedId, transferNotes, status: AdmissionStatus.TRANSFERRED },
        });
      });

      await logAudit(req.user?.userId, 'TRANSFER', 'admission', admission.id);
      return sendSuccess(res, null, 'Patient transferred successfully');
    } catch (error) {
      next(error);
    }
  }
}
