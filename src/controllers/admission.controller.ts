import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError, AppError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateAdmissionNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { BedStatus, AdmissionStatus } from '@prisma/client';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findAdmission = (id: string) =>
  db.orm.public.Admission.where((admission) =>
    or(admission.id.eq(id), admission.admissionNo.eq(id))
  ).first();

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

      const patient = await db.orm.public.Patient.where((record) =>
        or(record.id.eq(patientId), record.patientId.eq(patientId))
      ).first();
      if (!patient) throw new NotFoundError('Patient not found');

      // Check for existing active admission
      const activeAdmission = await db.orm.public.Admission
        .where({ patientId: patient.id, status: AdmissionStatus.ADMITTED })
        .first();
      if (activeAdmission) {
        throw new AppError('Patient already has an active admission', 409);
      }

      // Assign bed if specified
      if (bedId) {
        const bed = await db.orm.public.Bed.where({ id: bedId }).first();
        if (!bed) throw new NotFoundError('Bed not found');
        if (bed.status !== BedStatus.AVAILABLE) {
          throw new AppError('Bed is not available', 409);
        }
      }

      const admission = await db.transaction(async (tx) => {
        if (bedId) {
          const occupiedBed = await tx.orm.public.Bed.where({
            id: bedId,
            status: BedStatus.AVAILABLE,
          }).update({
            status: BedStatus.OCCUPIED,
          });
          if (!occupiedBed) throw new AppError('Bed is no longer available', 409);
        }
        const created = await tx.orm.public.Admission.create({
          admissionNo: generateAdmissionNo(),
          patientId: patient.id,
          bedId,
          admittingDoctorId,
          admissionReason,
          expectedDischarge: expectedDischarge
            ? toTimestampString(new Date(expectedDischarge))
            : undefined,
          referralSource,
        });
        return tx.orm.public.Admission
          .include('patient', (record) => record.select('firstName', 'lastName', 'patientId'))
          .include('bed', (record) => record.include('ward'))
          .where({ id: created.id })
          .first();
      });
      if (!admission) throw new NotFoundError('Admission could not be created');

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

      const query = db.orm.public.Admission.where((admission) =>
        and(
          patientId ? admission.patientId.eq(patientId as string) : all(),
          status ? admission.status.eq(status as AdmissionStatus) : all(),
          wardId ? admission.bed.some({ wardId: wardId as string }) : all()
        )
      );

      const [total, admissions] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId', 'phone'))
          .include('bed', (bed) => bed.include('ward', (ward) => ward.select('name', 'wardCode')))
          .orderBy((admission) => admission.admissionDate.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, admissions, 'Admissions retrieved', 200, buildPaginationMeta(total.total, page, limit));
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
      const admission = await db.orm.public.Admission
        .include('patient')
        .include('bed', (bed) => bed.include('ward', (ward) => ward.include('department')))
        .include('medicalRecords', (records) =>
          records
            .include('diagnoses')
            .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
            .orderBy((record) => record.visitDate.desc())
        )
        .include('vitalSigns', (vitals) => vitals.orderBy((vital) => vital.recordedAt.desc()).limit(5))
        .include('surgeries')
        .where((record) => or(record.id.eq(id), record.admissionNo.eq(id)))
        .first();

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

      const admission = await db.orm.public.Admission
        .include('bed')
        .where((record) => or(record.id.eq(id), record.admissionNo.eq(id)))
        .first();
      if (!admission) throw new NotFoundError('Admission not found');
      if (admission.status === AdmissionStatus.DISCHARGED) {
        throw new AppError('Patient already discharged', 400);
      }

      await db.transaction(async (tx) => {
        await tx.orm.public.Admission.where({ id: admission.id }).update({
            status: AdmissionStatus.DISCHARGED,
            dischargeDate: toTimestampString(new Date()),
            dischargeNotes,
        });

        // Free up the bed
        if (admission.bedId) {
          await tx.orm.public.Bed.where({ id: admission.bedId }).update({ status: BedStatus.AVAILABLE });
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

      const admission = await db.orm.public.Admission
        .include('bed')
        .where((record) => or(record.id.eq(id), record.admissionNo.eq(id)))
        .first();
      if (!admission) throw new NotFoundError('Admission not found');
      if (admission.status !== AdmissionStatus.ADMITTED) {
        throw new AppError('Patient is not currently admitted', 400);
      }

      const newBed = await db.orm.public.Bed.where({ id: newBedId }).first();
      if (!newBed) throw new NotFoundError('New bed not found');
      if (newBed.status !== BedStatus.AVAILABLE) {
        throw new AppError('New bed is not available', 409);
      }

      await db.transaction(async (tx) => {
        // Free old bed
        if (admission.bedId) {
          await tx.orm.public.Bed.where({ id: admission.bedId }).update({ status: BedStatus.AVAILABLE });
        }
        // Occupy new bed
        const occupiedBed = await tx.orm.public.Bed.where({
          id: newBedId,
          status: BedStatus.AVAILABLE,
        }).update({
          status: BedStatus.OCCUPIED,
        });
        if (!occupiedBed) throw new AppError('New bed is no longer available', 409);
        // Update admission
        await tx.orm.public.Admission.where({ id: admission.id }).update({
          bedId: newBedId,
          transferNotes,
          status: AdmissionStatus.TRANSFERRED,
        });
      });

      await logAudit(req.user?.userId, 'TRANSFER', 'admission', admission.id);
      return sendSuccess(res, null, 'Patient transferred successfully');
    } catch (error) {
      next(error);
    }
  }
}
