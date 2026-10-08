import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { BloodGroup, Gender } from '@prisma/client';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generatePatientId } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findPatient = (id: string) =>
  db.orm.public.Patient.where((patient) =>
    or(patient.id.eq(id), patient.patientId.eq(id))
  ).first();

export class PatientController {
  /**
   * POST /patients
   */
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        firstName, lastName, middleName, gender, dateOfBirth, phone, email,
        address, city, state, country, bloodGroup, genotype, maritalStatus,
        occupation, nationality, nextOfKinName, nextOfKinPhone, nextOfKinRelation,
        allergies, chronicConditions, userId,
      } = req.body;

      const patientId = generatePatientId();

      const patient = await db.orm.public.Patient.create({
          patientId,
          firstName, lastName, middleName, gender,
          dateOfBirth: toTimestampString(new Date(dateOfBirth)),
          phone, email, address, city, state, country,
          bloodGroup, genotype, maritalStatus, occupation, nationality,
          nextOfKinName, nextOfKinPhone, nextOfKinRelation,
          allergies: allergies || [],
          chronicConditions: chronicConditions || [],
          userId,
        });

      await logAudit(req.user?.userId, 'CREATE', 'patient', patient.id, null, patient, req.ip);
      return sendCreated(res, patient, 'Patient registered successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients
   */
  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string,
        req.query.limit as string
      );
      const { search, bloodGroup, gender } = req.query;

      const pattern = search
        ? `%${String(search).replace(/[\\%_]/g, '\\$&')}%`
        : undefined;
      const query = db.orm.public.Patient.where((patient) =>
        and(
          pattern
            ? or(
                patient.firstName.ilike(pattern),
                patient.lastName.ilike(pattern),
                patient.patientId.ilike(pattern),
                patient.phone.ilike(pattern),
                patient.email.ilike(pattern)
              )
            : all(),
          bloodGroup ? patient.bloodGroup.eq(bloodGroup as BloodGroup) : all(),
          gender ? patient.gender.eq(gender as Gender) : all()
        )
      );

      const [count, patients] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .select(
            'id', 'patientId', 'firstName', 'lastName', 'gender', 'dateOfBirth',
            'phone', 'email', 'bloodGroup', 'maritalStatus', 'profilePhoto',
            'createdAt', 'isDeceased'
          )
          .orderBy((patient) => patient.createdAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);
      const total = count.total;

      return sendSuccess(res, patients, 'Patients retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients/:id
   */
  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await db.orm.public.Patient
        .include('emergencyContacts')
        .include('insurances')
        .include('user', (user) => user.select('email', 'role', 'isEmailVerified'))
        .where((record) => or(record.id.eq(id), record.patientId.eq(id)))
        .first();

      if (!patient) throw new NotFoundError('Patient not found');
      return sendSuccess(res, patient);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /patients/:id
   */
  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const existing = await findPatient(id);
      if (!existing) throw new NotFoundError('Patient not found');

      const {
        firstName, lastName, middleName, gender, dateOfBirth, phone, email,
        address, city, state, country, bloodGroup, genotype, maritalStatus,
        occupation, nationality, nextOfKinName, nextOfKinPhone, nextOfKinRelation,
        allergies, chronicConditions,
      } = req.body;

      const patient = await db.orm.public.Patient.where({ id: existing.id }).update({
          firstName, lastName, middleName, gender,
          dateOfBirth: dateOfBirth ? toTimestampString(new Date(dateOfBirth)) : undefined,
          phone, email, address, city, state, country,
          bloodGroup, genotype, maritalStatus, occupation, nationality,
          nextOfKinName, nextOfKinPhone, nextOfKinRelation,
          allergies, chronicConditions,
      });
      if (!patient) throw new NotFoundError('Patient not found');

      await logAudit(req.user?.userId, 'UPDATE', 'patient', patient.id, existing, patient);
      return sendSuccess(res, patient, 'Patient updated successfully');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients/:id/medical-history
   */
  static async getMedicalHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const history = await db.orm.public.MedicalRecord
        .include('doctor', (doctor) =>
          doctor
            .include('staff', (staff) => staff.select('firstName', 'lastName'))
            .include('specialization')
        )
        .include('diagnoses')
        .include('vitalSigns', (vitals) =>
          vitals.orderBy((vital) => vital.recordedAt.desc()).limit(1)
        )
        .include('prescriptions', (prescriptions) =>
          prescriptions.include('items', (items) => items.include('medication'))
        )
        .include('labOrders', (orders) =>
          orders.include('items', (items) => items.include('labTest'))
        )
        .where({ patientId: patient.id })
        .orderBy((record) => record.visitDate.desc())
        .all();

      return sendSuccess(res, history, 'Medical history retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients/:id/vitals
   */
  static async getVitals(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );

      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const [total, vitals] = await Promise.all([
        db.orm.public.VitalSign
          .where({ patientId: patient.id })
          .aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.VitalSign
          .include('nurse', (nurse) => nurse.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .where({ patientId: patient.id })
          .orderBy((vital) => vital.recordedAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, vitals, 'Vitals retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients/:id/admissions
   */
  static async getAdmissions(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const admissions = await db.orm.public.Admission
        .include('bed', (bed) => bed.include('ward'))
        .where({ patientId: patient.id })
        .orderBy((admission) => admission.admissionDate.desc())
        .all();

      return sendSuccess(res, admissions, 'Admissions retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /patients/:id/bills
   */
  static async getBills(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const bills = await db.orm.public.Bill
        .include('items')
        .include('payments')
        .include('insurances', (claims) => claims.include('insurance'))
        .where({ patientId: patient.id })
        .orderBy((bill) => bill.createdAt.desc())
        .all();

      return sendSuccess(res, bills, 'Bills retrieved');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /patients/:id/emergency-contacts
   */
  static async addEmergencyContact(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const contact = await db.orm.public.EmergencyContact.create({ ...req.body, patientId: patient.id });

      return sendCreated(res, contact, 'Emergency contact added');
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /patients/:id/insurance
   */
  static async addInsurance(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      const { startDate, endDate, memberDob, verificationDate, ...rest } = req.body;
      const insurance = await db.orm.public.Insurance.create({
          ...rest,
          patientId: patient.id,
          startDate: toTimestampString(new Date(startDate)),
          endDate: endDate ? toTimestampString(new Date(endDate)) : undefined,
          memberDob: memberDob ? toTimestampString(new Date(memberDob)) : undefined,
          verificationDate: verificationDate ? toTimestampString(new Date(verificationDate)) : undefined,
      });

      return sendCreated(res, insurance, 'Insurance added');
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /patients/:id
   */
  static async deactivate(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const patient = await findPatient(id);
      if (!patient) throw new NotFoundError('Patient not found');

      await db.orm.public.Patient.where({ id: patient.id }).update({
        isDeceased: true,
        deceasedAt: toTimestampString(new Date()),
      });

      await logAudit(req.user?.userId, 'MARK_DECEASED', 'patient', patient.id);
      return sendSuccess(res, null, 'Patient record updated');
    } catch (error) {
      next(error);
    }
  }
}
