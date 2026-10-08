import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateRecordNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

export class MedicalRecordController {
  /**
   * POST /medical-records
   */
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, doctorId, appointmentId, admissionId,
        chiefComplaint, historyOfPresentIllness, pastMedicalHistory,
        familyHistory, socialHistory, reviewOfSystems, physicalExamination,
        assessment, plan, followUpDate, followUpNotes, isConfidential,
        diagnoses,
      } = req.body;

      const [patient, doctor] = await Promise.all([
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findFirst({ where: { OR: [{ id: doctorId }, { staff: { staffId: doctorId } }] } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const record = await prisma.medicalRecord.create({
        data: {
          recordNo: generateRecordNo(),
          patientId: patient.id,
          doctorId: doctor.id,
          appointmentId,
          admissionId,
          chiefComplaint,
          historyOfPresentIllness,
          pastMedicalHistory,
          familyHistory,
          socialHistory,
          reviewOfSystems,
          physicalExamination,
          assessment,
          plan,
          followUpDate: followUpDate ? new Date(followUpDate) : undefined,
          followUpNotes,
          isConfidential: isConfidential || false,
          diagnoses: diagnoses
            ? {
                create: diagnoses.map((d: { name: string; icdCode?: string; description?: string; isPrimary?: boolean }) => ({
                  name: d.name,
                  icdCode: d.icdCode,
                  description: d.description,
                  isPrimary: d.isPrimary || false,
                })),
              }
            : undefined,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          diagnoses: true,
        },
      });

      await logAudit(req.user?.userId, 'CREATE', 'medical_record', record.id, null, record);
      return sendCreated(res, record, 'Medical record created');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /medical-records
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, doctorId } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (doctorId) where.doctorId = doctorId;

      const [total, records] = await Promise.all([
        prisma.medicalRecord.count({ where }),
        prisma.medicalRecord.findMany({
          where,
          skip,
          take: limit,
          orderBy: { visitDate: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            doctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
            diagnoses: true,
          },
        }),
      ]);

      return sendSuccess(res, records, 'Medical records retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /medical-records/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const record = await prisma.medicalRecord.findFirst({
        where: { OR: [{ id }, { recordNo: id }] },
        include: {
          patient: true,
          doctor: {
            include: {
              staff: { select: { firstName: true, lastName: true, profilePhoto: true } },
              specialization: true,
            },
          },
          diagnoses: true,
          vitalSigns: { orderBy: { recordedAt: 'desc' } },
          prescriptions: {
            include: { items: { include: { medication: true } } },
          },
          labOrders: {
            include: { items: { include: { labTest: true } } },
          },
          radiologyOrders: true,
          nurseNotes: {
            include: { nurse: { include: { staff: { select: { firstName: true, lastName: true } } } } },
          },
          appointment: { select: { appointmentNo: true, type: true, scheduledAt: true } },
        },
      });

      if (!record) throw new NotFoundError('Medical record not found');
      return sendSuccess(res, record);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /medical-records/:id
   */
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const existing = await prisma.medicalRecord.findFirst({
        where: { OR: [{ id }, { recordNo: id }] },
      });
      if (!existing) throw new NotFoundError('Medical record not found');

      const {
        chiefComplaint, historyOfPresentIllness, pastMedicalHistory,
        familyHistory, socialHistory, reviewOfSystems, physicalExamination,
        assessment, plan, followUpDate, followUpNotes,
      } = req.body;

      const record = await prisma.medicalRecord.update({
        where: { id: existing.id },
        data: {
          chiefComplaint, historyOfPresentIllness, pastMedicalHistory,
          familyHistory, socialHistory, reviewOfSystems, physicalExamination,
          assessment, plan,
          followUpDate: followUpDate ? new Date(followUpDate) : undefined,
          followUpNotes,
        },
        include: { diagnoses: true },
      });

      await logAudit(req.user?.userId, 'UPDATE', 'medical_record', record.id);
      return sendSuccess(res, record, 'Medical record updated');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /medical-records/:id/diagnoses
   */
  static async addDiagnosis(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const record = await prisma.medicalRecord.findFirst({
        where: { OR: [{ id }, { recordNo: id }] },
      });
      if (!record) throw new NotFoundError('Medical record not found');

      const { name, icdCode, description, isPrimary } = req.body;
      const diagnosis = await prisma.diagnosis.create({
        data: {
          medicalRecordId: record.id,
          name, icdCode, description,
          isPrimary: isPrimary || false,
        },
      });

      return sendCreated(res, diagnosis, 'Diagnosis added');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /medical-records/:id/vitals
   */
  static async addVitals(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const record = await prisma.medicalRecord.findFirst({
        where: { OR: [{ id }, { recordNo: id }] },
      });
      if (!record) throw new NotFoundError('Medical record not found');

      // Get nurse ID if the user is a nurse
      let nurseId: string | undefined;
      if (req.user?.role === 'NURSE') {
        const nurse = await prisma.nurse.findFirst({
          where: { staff: { userId: req.user.userId } },
        });
        nurseId = nurse?.id;
      }

      const {
        bloodPressureSystolic, bloodPressureDiastolic, heartRate,
        temperature, temperatureUnit, respiratoryRate, oxygenSaturation,
        weight, weightUnit, height, heightUnit, bmi, bloodGlucose,
        bloodGlucoseUnit, painScale, notes,
      } = req.body;

      // Auto-calculate BMI if weight and height provided
      let calculatedBMI = bmi;
      if (weight && height && !bmi) {
        const heightM = height / 100;
        calculatedBMI = parseFloat((weight / (heightM * heightM)).toFixed(1));
      }

      const vital = await prisma.vitalSign.create({
        data: {
          patientId: record.patientId,
          medicalRecordId: record.id,
          nurseId,
          bloodPressureSystolic, bloodPressureDiastolic, heartRate,
          temperature, temperatureUnit, respiratoryRate, oxygenSaturation,
          weight, weightUnit, height, heightUnit, bmi: calculatedBMI,
          bloodGlucose, bloodGlucoseUnit, painScale, notes,
        },
      });

      return sendCreated(res, vital, 'Vitals recorded');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /medical-records/:id/nurse-notes
   */
  static async addNurseNote(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const record = await prisma.medicalRecord.findFirst({
        where: { OR: [{ id }, { recordNo: id }] },
      });
      if (!record) throw new NotFoundError('Medical record not found');

      let nurseId: string | undefined;
      if (req.user?.role === 'NURSE') {
        const nurse = await prisma.nurse.findFirst({
          where: { staff: { userId: req.user.userId } },
        });
        nurseId = nurse?.id;
      }

      const { note, noteType } = req.body;
      const nurseNote = await prisma.nurseNote.create({
        data: {
          medicalRecordId: record.id,
          patientId: record.patientId,
          nurseId,
          note,
          noteType: noteType || 'GENERAL',
        },
      });

      return sendCreated(res, nurseNote, 'Nurse note added');
    } catch (error) {
      next(error);
    }
  }
}
