import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generatePatientId } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

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

      const patient = await prisma.patient.create({
        data: {
          patientId,
          firstName, lastName, middleName, gender,
          dateOfBirth: new Date(dateOfBirth),
          phone, email, address, city, state, country,
          bloodGroup, genotype, maritalStatus, occupation, nationality,
          nextOfKinName, nextOfKinPhone, nextOfKinRelation,
          allergies: allergies || [],
          chronicConditions: chronicConditions || [],
          userId,
        },
        include: { emergencyContacts: true, insurances: true },
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

      const where: Record<string, unknown> = {};
      if (search) {
        where.OR = [
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName: { contains: search as string, mode: 'insensitive' } },
          { patientId: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
          { email: { contains: search as string, mode: 'insensitive' } },
        ];
      }
      if (bloodGroup) where.bloodGroup = bloodGroup;
      if (gender) where.gender = gender;

      const [total, patients] = await Promise.all([
        prisma.patient.count({ where }),
        prisma.patient.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, patientId: true, firstName: true, lastName: true,
            gender: true, dateOfBirth: true, phone: true, email: true,
            bloodGroup: true, maritalStatus: true, profilePhoto: true,
            createdAt: true, isDeceased: true,
          },
        }),
      ]);

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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
        include: {
          emergencyContacts: true,
          insurances: true,
          user: { select: { email: true, role: true, isEmailVerified: true } },
        },
      });

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
      const existing = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!existing) throw new NotFoundError('Patient not found');

      const {
        firstName, lastName, middleName, gender, dateOfBirth, phone, email,
        address, city, state, country, bloodGroup, genotype, maritalStatus,
        occupation, nationality, nextOfKinName, nextOfKinPhone, nextOfKinRelation,
        allergies, chronicConditions,
      } = req.body;

      const patient = await prisma.patient.update({
        where: { id: existing.id },
        data: {
          firstName, lastName, middleName, gender,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          phone, email, address, city, state, country,
          bloodGroup, genotype, maritalStatus, occupation, nationality,
          nextOfKinName, nextOfKinPhone, nextOfKinRelation,
          allergies, chronicConditions,
        },
      });

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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const history = await prisma.medicalRecord.findMany({
        where: { patientId: patient.id },
        orderBy: { visitDate: 'desc' },
        include: {
          doctor: {
            include: {
              staff: { select: { firstName: true, lastName: true } },
              specialization: true,
            },
          },
          diagnoses: true,
          vitalSigns: { orderBy: { recordedAt: 'desc' }, take: 1 },
          prescriptions: { include: { items: { include: { medication: true } } } },
          labOrders: { include: { items: { include: { labTest: true } } } },
        },
      });

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

      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const [total, vitals] = await Promise.all([
        prisma.vitalSign.count({ where: { patientId: patient.id } }),
        prisma.vitalSign.findMany({
          where: { patientId: patient.id },
          orderBy: { recordedAt: 'desc' },
          skip,
          take: limit,
          include: {
            nurse: { include: { staff: { select: { firstName: true, lastName: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, vitals, 'Vitals retrieved', 200, buildPaginationMeta(total, page, limit));
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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const admissions = await prisma.admission.findMany({
        where: { patientId: patient.id },
        orderBy: { admissionDate: 'desc' },
        include: {
          bed: { include: { ward: true } },
        },
      });

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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const bills = await prisma.bill.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          payments: true,
          insurances: { include: { insurance: true } },
        },
      });

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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const contact = await prisma.emergencyContact.create({
        data: { ...req.body, patientId: patient.id },
      });

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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const { startDate, endDate, memberDob, verificationDate, ...rest } = req.body;
      const insurance = await prisma.insurance.create({
        data: {
          ...rest,
          patientId: patient.id,
          startDate: new Date(startDate),
          endDate: endDate ? new Date(endDate) : undefined,
          memberDob: memberDob ? new Date(memberDob) : undefined,
          verificationDate: verificationDate ? new Date(verificationDate) : undefined,
        },
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
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id }, { patientId: id }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      await prisma.patient.update({
        where: { id: patient.id },
        data: { isDeceased: true, deceasedAt: new Date() },
      });

      await logAudit(req.user?.userId, 'MARK_DECEASED', 'patient', patient.id);
      return sendSuccess(res, null, 'Patient record updated');
    } catch (error) {
      next(error);
    }
  }
}
