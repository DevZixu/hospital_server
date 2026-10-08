import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateRecordNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findRecord = (id: string) =>
  db.orm.public.MedicalRecord.where((record) => or(record.id.eq(id), record.recordNo.eq(id))).first();

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
        db.orm.public.Patient.where((patient) =>
          or(patient.id.eq(patientId), patient.patientId.eq(patientId))
        ).first(),
        db.orm.public.Doctor.where((doctor) =>
          or(doctor.id.eq(doctorId), doctor.staff.some({ staffId: doctorId }))
        ).first(),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Doctor not found');

      const created = await db.orm.public.MedicalRecord.create({
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
          followUpDate: followUpDate ? toTimestampString(new Date(followUpDate)) : undefined,
          followUpNotes,
          isConfidential: isConfidential || false,
          diagnoses: diagnoses
            ? (items) => items.create(diagnoses.map((d: { name: string; icdCode?: string; description?: string; isPrimary?: boolean }) => ({
                  name: d.name,
                  icdCode: d.icdCode,
                  description: d.description,
                  isPrimary: d.isPrimary || false,
                })))
            : undefined,
      });
      const record = await db.orm.public.MedicalRecord
        .include('patient', (record) => record.select('firstName', 'lastName', 'patientId'))
        .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('diagnoses')
        .where({ id: created.id })
        .first();
      if (!record) throw new NotFoundError('Medical record could not be created');

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

      const query = db.orm.public.MedicalRecord.where((record) =>
        and(
          patientId ? record.patientId.eq(patientId as string) : all(),
          doctorId ? record.doctorId.eq(doctorId as string) : all()
        )
      );

      const [total, records] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('doctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .include('diagnoses')
          .orderBy((record) => record.visitDate.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, records, 'Medical records retrieved', 200, buildPaginationMeta(total.total, page, limit));
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
      const record = await db.orm.public.MedicalRecord
        .include('patient')
        .include('doctor', (doctor) =>
          doctor
            .include('staff', (staff) => staff.select('firstName', 'lastName', 'profilePhoto'))
            .include('specialization')
        )
        .include('diagnoses')
        .include('vitalSigns', (vitals) => vitals.orderBy((vital) => vital.recordedAt.desc()))
        .include('prescriptions', (prescriptions) =>
          prescriptions.include('items', (items) => items.include('medication'))
        )
        .include('labOrders', (orders) => orders.include('items', (items) => items.include('labTest')))
        .include('radiologyOrders')
        .include('nurseNotes', (notes) =>
          notes.include('nurse', (nurse) => nurse.include('staff', (staff) => staff.select('firstName', 'lastName')))
        )
        .include('appointment', (appointment) => appointment.select('appointmentNo', 'type', 'scheduledAt'))
        .where((item) => or(item.id.eq(id), item.recordNo.eq(id)))
        .first();

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
      const existing = await findRecord(id);
      if (!existing) throw new NotFoundError('Medical record not found');

      const {
        chiefComplaint, historyOfPresentIllness, pastMedicalHistory,
        familyHistory, socialHistory, reviewOfSystems, physicalExamination,
        assessment, plan, followUpDate, followUpNotes,
      } = req.body;

      const record = await db.orm.public.MedicalRecord
        .include('diagnoses')
        .where({ id: existing.id })
        .update({
          chiefComplaint, historyOfPresentIllness, pastMedicalHistory,
          familyHistory, socialHistory, reviewOfSystems, physicalExamination,
          assessment, plan,
          followUpDate: followUpDate ? toTimestampString(new Date(followUpDate)) : undefined,
          followUpNotes,
      });
      if (!record) throw new NotFoundError('Medical record not found');

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
      const record = await findRecord(id);
      if (!record) throw new NotFoundError('Medical record not found');

      const { name, icdCode, description, isPrimary } = req.body;
      const diagnosis = await db.orm.public.Diagnosis.create({
          medicalRecordId: record.id,
          name, icdCode, description,
          isPrimary: isPrimary || false,
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
      const record = await findRecord(id);
      if (!record) throw new NotFoundError('Medical record not found');

      // Get nurse ID if the user is a nurse
      let nurseId: string | undefined;
      if (req.user?.role === 'NURSE') {
        const nurse = await db.orm.public.Nurse.where((item) => item.staff.some({ userId: req.user!.userId })).first();
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

      const vital = await db.orm.public.VitalSign.create({
          patientId: record.patientId,
          medicalRecordId: record.id,
          nurseId,
          bloodPressureSystolic, bloodPressureDiastolic, heartRate,
          temperature, temperatureUnit, respiratoryRate, oxygenSaturation,
          weight, weightUnit, height, heightUnit, bmi: calculatedBMI,
          bloodGlucose, bloodGlucoseUnit, painScale, notes,
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
      const record = await findRecord(id);
      if (!record) throw new NotFoundError('Medical record not found');

      let nurseId: string | undefined;
      if (req.user?.role === 'NURSE') {
        const nurse = await db.orm.public.Nurse.where((item) => item.staff.some({ userId: req.user!.userId })).first();
        nurseId = nurse?.id;
      }

      const { note, noteType } = req.body;
      const nurseNote = await db.orm.public.NurseNote.create({
          medicalRecordId: record.id,
          patientId: record.patientId,
          nurseId,
          note,
          noteType: noteType || 'GENERAL',
      });

      return sendCreated(res, nurseNote, 'Nurse note added');
    } catch (error) {
      next(error);
    }
  }
}
