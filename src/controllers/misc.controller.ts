import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateReferralNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findPatient = (id: string) =>
  db.orm.public.Patient.where((patient) => or(patient.id.eq(id), patient.patientId.eq(id))).first();

const findReferral = (id: string) =>
  db.orm.public.Referral.where((referral) => or(referral.id.eq(id), referral.referralNo.eq(id))).first();

export class ReferralController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, referringDoctorId, referredToDoctorId,
        referredToFacility, reason, urgency, notes,
      } = req.body;

      const [patient, doctor] = await Promise.all([
        findPatient(patientId),
        db.orm.public.Doctor.where({ id: referringDoctorId }).first(),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Referring doctor not found');

      const created = await db.orm.public.Referral.create({
          referralNo: generateReferralNo(),
          patientId: patient.id,
          referringDoctorId: doctor.id,
          referredToDoctorId,
          referredToFacility,
          reason, urgency, notes,
      });
      const referral = await db.orm.public.Referral
        .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
        .include('referringDoctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .include('referredToDoctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
        .where({ id: created.id })
        .first();
      if (!referral) throw new NotFoundError('Referral could not be created');

      await logAudit(req.user?.userId, 'CREATE_REFERRAL', 'referral', referral.id, null, referral);
      return sendCreated(res, referral, 'Referral created');
    } catch (error) { next(error); }
  }

  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, status } = req.query;

      const query = db.orm.public.Referral.where((referral) =>
        and(
          patientId ? referral.patientId.eq(patientId as string) : all(),
          status ? referral.status.eq(status as string) : all()
        )
      );

      const [total, referrals] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
          .include('referringDoctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .include('referredToDoctor', (doctor) => doctor.include('staff', (staff) => staff.select('firstName', 'lastName')))
          .orderBy((referral) => referral.referredAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, referrals, 'Referrals retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const referral = await findReferral(id);
      if (!referral) throw new NotFoundError('Referral not found');

      const updateData: Record<string, unknown> = { status };
      if (status === 'ACCEPTED') updateData.acceptedAt = toTimestampString(new Date());
      if (status === 'COMPLETED') updateData.completedAt = toTimestampString(new Date());

      const updated = await db.orm.public.Referral.where({ id: referral.id }).update(updateData as { status: string });
      if (!updated) throw new NotFoundError('Referral not found');

      return sendSuccess(res, updated, 'Referral status updated');
    } catch (error) { next(error); }
  }
}

// ─── IMMUNIZATION CONTROLLER ──────────────────────────────────────────────────

export class ImmunizationController {
  static async record(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await findPatient(patientId);
      if (!patient) throw new NotFoundError('Patient not found');

      const { administeredAt, expiryDate, nextDoseDate, ...rest } = req.body;
      const immunization = await db.orm.public.Immunization.create({
          patientId: patient.id,
          ...rest,
          administeredAt: administeredAt ? toTimestampString(new Date(administeredAt)) : undefined,
          expiryDate: expiryDate ? toTimestampString(new Date(expiryDate)) : undefined,
          nextDoseDate: nextDoseDate ? toTimestampString(new Date(nextDoseDate)) : undefined,
          administeredBy: req.body.administeredBy || req.user?.userId,
      });

      return sendCreated(res, immunization, 'Immunization recorded');
    } catch (error) { next(error); }
  }

  static async getForPatient(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await findPatient(patientId);
      if (!patient) throw new NotFoundError('Patient not found');

      const immunizations = await db.orm.public.Immunization.where({ patientId: patient.id })
        .orderBy((immunization) => immunization.administeredAt.desc())
        .all();

      return sendSuccess(res, immunizations, 'Immunizations retrieved');
    } catch (error) { next(error); }
  }
}

// ─── WARD/BED CONTROLLER ──────────────────────────────────────────────────────

export class WardController {
  static async createWard(req: Request, res: Response, next: NextFunction) {
    try {
      const ward = await db.orm.public.Ward.create(req.body);
      return sendCreated(res, ward, 'Ward created');
    } catch (error) { next(error); }
  }

  static async getWards(req: Request, res: Response, next: NextFunction) {
    try {
      const { departmentId, type } = req.query;
      const wards = await db.orm.public.Ward
        .include('department', (department) => department.select('name'))
        .include('beds')
        .include('nurses', (nurses) => nurses.count())
        .where((ward) =>
          and(
            ward.isActive.eq(true),
            departmentId ? ward.departmentId.eq(departmentId as string) : all(),
            type ? ward.type.eq(type as 'GENERAL' | 'PRIVATE' | 'ICU' | 'NICU' | 'EMERGENCY' | 'ISOLATION' | 'MATERNITY' | 'PEDIATRIC' | 'SURGICAL') : all()
          )
        )
        .all();

      // Compute availability
      const wardsWithAvailability = wards.map((w) => ({
        ...w,
        availableBeds: w.beds.filter((b) => b.status === 'AVAILABLE').length,
        occupiedBeds: w.beds.filter((b) => b.status === 'OCCUPIED').length,
      }));

      return sendSuccess(res, wardsWithAvailability, 'Wards retrieved');
    } catch (error) { next(error); }
  }

  static async createBed(req: Request, res: Response, next: NextFunction) {
    try {
      const { wardId } = req.params;
      const ward = await db.orm.public.Ward.where({ id: wardId }).first();
      if (!ward) throw new NotFoundError('Ward not found');

      const bed = await db.orm.public.Bed.create({ wardId, ...req.body });
      return sendCreated(res, bed, 'Bed created');
    } catch (error) { next(error); }
  }

  static async getBeds(req: Request, res: Response, next: NextFunction) {
    try {
      const { wardId } = req.params;
      const { status, type } = req.query;

      const beds = await db.orm.public.Bed
        .include('admissions', (admissions) =>
          admissions
            .include('patient', (patient) => patient.select('firstName', 'lastName', 'patientId'))
            .where({ status: 'ADMITTED' })
            .limit(1)
        )
        .where((bed) =>
          and(
            bed.wardId.eq(wardId),
            status ? bed.status.eq(status as 'AVAILABLE' | 'OCCUPIED' | 'MAINTENANCE' | 'RESERVED') : all(),
            type ? bed.type.eq(type as 'GENERAL' | 'PRIVATE' | 'ICU' | 'NICU' | 'EMERGENCY' | 'ISOLATION' | 'MATERNITY' | 'PEDIATRIC' | 'SURGICAL') : all()
          )
        )
        .orderBy((bed) => bed.bedNumber.asc())
        .all();

      return sendSuccess(res, beds, 'Beds retrieved');
    } catch (error) { next(error); }
  }
}

// ─── DEPARTMENT CONTROLLER ────────────────────────────────────────────────────

export class DepartmentController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await db.orm.public.Department.create(req.body);
      return sendCreated(res, dept, 'Department created');
    } catch (error) { next(error); }
  }

  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const departments = await db.orm.public.Department
        .include('head', (head) => head.select('firstName', 'lastName'))
        .include('staff', (staff) => staff.count())
        .include('appointments', (appointments) => appointments.count())
        .where({ isActive: true })
        .all();
      return sendSuccess(res, departments, 'Departments retrieved');
    } catch (error) { next(error); }
  }

  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await db.orm.public.Department
        .include('head')
        .include('staff', (staff) => staff.include('user', (user) => user.select('role')).include('doctor', (doctor) => doctor.include('specialization')))
        .include('wards')
        .where((record) => or(record.id.eq(req.params.id), record.code.eq(req.params.id)))
        .first();
      if (!dept) throw new NotFoundError('Department not found');
      return sendSuccess(res, dept);
    } catch (error) { next(error); }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await db.orm.public.Department.where({ id: req.params.id }).update(req.body);
      if (!dept) throw new NotFoundError('Department not found');
      return sendSuccess(res, dept, 'Department updated');
    } catch (error) { next(error); }
  }
}

// ─── NOTIFICATION CONTROLLER ──────────────────────────────────────────────────

export class NotificationController {
  static async getMyNotifications(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const userId = req.user!.userId;
      const isRead = req.query.isRead === 'true' ? true : req.query.isRead === 'false' ? false : undefined;

      const query = db.orm.public.Notification.where((notification) =>
        and(notification.userId.eq(userId), isRead !== undefined ? notification.isRead.eq(isRead) : all())
      );

      const [total, notifications] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query.orderBy((notification) => notification.createdAt.desc()).offset(skip).limit(limit).all(),
      ]);

      return sendSuccess(res, notifications, 'Notifications retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  static async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const userId = req.user!.userId;

      await db.orm.public.Notification.where({ id, userId }).updateAll({
        isRead: true,
        readAt: toTimestampString(new Date()),
      });

      return sendSuccess(res, null, 'Notification marked as read');
    } catch (error) { next(error); }
  }

  static async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      await db.orm.public.Notification.where({ userId, isRead: false }).updateAll({
        isRead: true,
        readAt: toTimestampString(new Date()),
      });
      return sendSuccess(res, null, 'All notifications marked as read');
    } catch (error) { next(error); }
  }
}

// ─── DOCUMENT CONTROLLER ──────────────────────────────────────────────────────

export class DocumentController {
  static async upload(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const { type, title, description, isConfidential } = req.body;
      const file = req.file;

      if (!file) throw new Error('No file uploaded');

      const patient = await findPatient(patientId);
      if (!patient) throw new NotFoundError('Patient not found');

      const doc = await db.orm.public.MedicalDocument.create({
          patientId: patient.id,
          type,
          title,
          description,
          fileUrl: `/uploads/documents/${file.filename}`,
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          uploadedBy: req.user?.userId,
          isConfidential: isConfidential === 'true',
      });

      return sendCreated(res, doc, 'Document uploaded');
    } catch (error) { next(error); }
  }

  static async getForPatient(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await findPatient(patientId);
      if (!patient) throw new NotFoundError('Patient not found');

      const docs = await db.orm.public.MedicalDocument.where({ patientId: patient.id })
        .orderBy((document) => document.uploadedAt.desc())
        .all();

      return sendSuccess(res, docs, 'Documents retrieved');
    } catch (error) { next(error); }
  }
}

// ─── DASHBOARD / STATS CONTROLLER ─────────────────────────────────────────────

export class DashboardController {
  static async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);

      const [
        patientStats,
        doctorStats,
        staffStats,
        appointmentStats,
        admissionStats,
        billStats,
        labStats,
        emergencyStats,
        surgeryStats,
        bedStats,
      ] = await Promise.all([
        db.orm.public.Patient.where({ isDeceased: false }).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Doctor.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Staff.aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Appointment.where((appointment) =>
          and(appointment.scheduledAt.gte(toTimestampString(today)), appointment.scheduledAt.lte(toTimestampString(todayEnd)))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Admission.where({ status: 'ADMITTED' }).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Bill.where((bill) =>
          or(bill.status.eq('PENDING'), bill.status.eq('OVERDUE'), bill.status.eq('PARTIAL'))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.LabOrderItem.where((item) =>
          or(item.status.eq('ORDERED'), item.status.eq('SAMPLE_COLLECTED'), item.status.eq('IN_PROGRESS'))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.EmergencyVisit.where((visit) =>
          and(visit.triageTime.gte(toTimestampString(today)), visit.triageTime.lte(toTimestampString(todayEnd)))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Surgery.where((surgery) =>
          and(surgery.scheduledAt.gte(toTimestampString(today)), surgery.scheduledAt.lte(toTimestampString(todayEnd)))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Bed.groupBy('status').aggregate((aggregate) => ({ total: aggregate.count() })),
      ]);

      const bedSummary = bedStats.reduce<Record<string, number>>((acc, bed) => {
        acc[bed.status] = bed.total;
        return acc;
      }, {});

      return sendSuccess(res, {
        patients: { total: patientStats.total },
        staff: { total: staffStats.total, doctors: doctorStats.total },
        appointments: { today: appointmentStats.total },
        admissions: { active: admissionStats.total },
        beds: { ...bedSummary },
        billing: { pendingBills: billStats.total },
        laboratory: { pendingOrders: labStats.total },
        emergency: { today: emergencyStats.total },
        surgery: { today: surgeryStats.total },
      }, 'Dashboard stats retrieved');
    } catch (error) { next(error); }
  }
}
