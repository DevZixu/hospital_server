import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateReferralNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';

export class ReferralController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        patientId, referringDoctorId, referredToDoctorId,
        referredToFacility, reason, urgency, notes,
      } = req.body;

      const [patient, doctor] = await Promise.all([
        prisma.patient.findFirst({ where: { OR: [{ id: patientId }, { patientId }] } }),
        prisma.doctor.findUnique({ where: { id: referringDoctorId } }),
      ]);

      if (!patient) throw new NotFoundError('Patient not found');
      if (!doctor) throw new NotFoundError('Referring doctor not found');

      const referral = await prisma.referral.create({
        data: {
          referralNo: generateReferralNo(),
          patientId: patient.id,
          referringDoctorId: doctor.id,
          referredToDoctorId,
          referredToFacility,
          reason, urgency, notes,
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          referringDoctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          referredToDoctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
        },
      });

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

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.status = status;

      const [total, referrals] = await Promise.all([
        prisma.referral.count({ where }),
        prisma.referral.findMany({
          where, skip, take: limit, orderBy: { referredAt: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            referringDoctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
            referredToDoctor: { include: { staff: { select: { firstName: true, lastName: true } } } },
          },
        }),
      ]);

      return sendSuccess(res, referrals, 'Referrals retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  static async updateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const referral = await prisma.referral.findFirst({
        where: { OR: [{ id }, { referralNo: id }] },
      });
      if (!referral) throw new NotFoundError('Referral not found');

      const updateData: Record<string, unknown> = { status };
      if (status === 'ACCEPTED') updateData.acceptedAt = new Date();
      if (status === 'COMPLETED') updateData.completedAt = new Date();

      const updated = await prisma.referral.update({
        where: { id: referral.id },
        data: updateData,
      });

      return sendSuccess(res, updated, 'Referral status updated');
    } catch (error) { next(error); }
  }
}

// ─── IMMUNIZATION CONTROLLER ──────────────────────────────────────────────────

export class ImmunizationController {
  static async record(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const { administeredAt, expiryDate, nextDoseDate, ...rest } = req.body;
      const immunization = await prisma.immunization.create({
        data: {
          patientId: patient.id,
          ...rest,
          administeredAt: administeredAt ? new Date(administeredAt) : undefined,
          expiryDate: expiryDate ? new Date(expiryDate) : undefined,
          nextDoseDate: nextDoseDate ? new Date(nextDoseDate) : undefined,
          administeredBy: req.body.administeredBy || req.user?.userId,
        },
      });

      return sendCreated(res, immunization, 'Immunization recorded');
    } catch (error) { next(error); }
  }

  static async getForPatient(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const immunizations = await prisma.immunization.findMany({
        where: { patientId: patient.id },
        orderBy: { administeredAt: 'desc' },
      });

      return sendSuccess(res, immunizations, 'Immunizations retrieved');
    } catch (error) { next(error); }
  }
}

// ─── WARD/BED CONTROLLER ──────────────────────────────────────────────────────

export class WardController {
  static async createWard(req: Request, res: Response, next: NextFunction) {
    try {
      const ward = await prisma.ward.create({ data: req.body });
      return sendCreated(res, ward, 'Ward created');
    } catch (error) { next(error); }
  }

  static async getWards(req: Request, res: Response, next: NextFunction) {
    try {
      const { departmentId, type } = req.query;
      const where: Record<string, unknown> = { isActive: true };
      if (departmentId) where.departmentId = departmentId;
      if (type) where.type = type;

      const wards = await prisma.ward.findMany({
        where,
        include: {
          department: { select: { name: true } },
          beds: true,
          _count: { select: { beds: true, nurses: true } },
        },
      });

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
      const ward = await prisma.ward.findUnique({ where: { id: wardId } });
      if (!ward) throw new NotFoundError('Ward not found');

      const bed = await prisma.bed.create({
        data: { wardId, ...req.body },
      });
      return sendCreated(res, bed, 'Bed created');
    } catch (error) { next(error); }
  }

  static async getBeds(req: Request, res: Response, next: NextFunction) {
    try {
      const { wardId } = req.params;
      const { status, type } = req.query;

      const where: Record<string, unknown> = { wardId };
      if (status) where.status = status;
      if (type) where.type = type;

      const beds = await prisma.bed.findMany({
        where, orderBy: { bedNumber: 'asc' },
        include: {
          admissions: {
            where: { status: 'ADMITTED' },
            include: {
              patient: { select: { firstName: true, lastName: true, patientId: true } },
            },
            take: 1,
          },
        },
      });

      return sendSuccess(res, beds, 'Beds retrieved');
    } catch (error) { next(error); }
  }
}

// ─── DEPARTMENT CONTROLLER ────────────────────────────────────────────────────

export class DepartmentController {
  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await prisma.department.create({ data: req.body });
      return sendCreated(res, dept, 'Department created');
    } catch (error) { next(error); }
  }

  static async findAll(req: Request, res: Response, next: NextFunction) {
    try {
      const departments = await prisma.department.findMany({
        where: { isActive: true },
        include: {
          head: { select: { firstName: true, lastName: true } },
          _count: { select: { staff: true, appointments: true } },
        },
      });
      return sendSuccess(res, departments, 'Departments retrieved');
    } catch (error) { next(error); }
  }

  static async findOne(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await prisma.department.findFirst({
        where: { OR: [{ id: req.params.id }, { code: req.params.id }] },
        include: {
          head: true,
          staff: {
            include: {
              user: { select: { role: true } },
              doctor: { include: { specialization: true } },
            },
          },
          wards: true,
        },
      });
      if (!dept) throw new NotFoundError('Department not found');
      return sendSuccess(res, dept);
    } catch (error) { next(error); }
  }

  static async update(req: Request, res: Response, next: NextFunction) {
    try {
      const dept = await prisma.department.update({
        where: { id: req.params.id },
        data: req.body,
      });
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

      const where: Record<string, unknown> = { userId };
      if (isRead !== undefined) where.isRead = isRead;

      const [total, notifications] = await Promise.all([
        prisma.notification.count({ where }),
        prisma.notification.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
        }),
      ]);

      return sendSuccess(res, notifications, 'Notifications retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  static async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const userId = req.user!.userId;

      await prisma.notification.updateMany({
        where: { id, userId },
        data: { isRead: true, readAt: new Date() },
      });

      return sendSuccess(res, null, 'Notification marked as read');
    } catch (error) { next(error); }
  }

  static async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
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

      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const doc = await prisma.medicalDocument.create({
        data: {
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
        },
      });

      return sendCreated(res, doc, 'Document uploaded');
    } catch (error) { next(error); }
  }

  static async getForPatient(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId } = req.params;
      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const docs = await prisma.medicalDocument.findMany({
        where: { patientId: patient.id },
        orderBy: { uploadedAt: 'desc' },
      });

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
        totalPatients,
        totalDoctors,
        totalStaff,
        todayAppointments,
        activeAdmissions,
        pendingBills,
        pendingLabOrders,
        emergencyToday,
        todaySurgeries,
        bedStats,
      ] = await Promise.all([
        prisma.patient.count({ where: { isDeceased: false } }),
        prisma.doctor.count(),
        prisma.staff.count(),
        prisma.appointment.count({ where: { scheduledAt: { gte: today, lte: todayEnd } } }),
        prisma.admission.count({ where: { status: 'ADMITTED' } }),
        prisma.bill.count({ where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } } }),
        prisma.labOrderItem.count({ where: { status: { in: ['ORDERED', 'SAMPLE_COLLECTED', 'IN_PROGRESS'] } } }),
        prisma.emergencyVisit.count({ where: { triageTime: { gte: today, lte: todayEnd } } }),
        prisma.surgery.count({ where: { scheduledAt: { gte: today, lte: todayEnd } } }),
        prisma.bed.groupBy({ by: ['status'], _count: { id: true } }),
      ]);

      const bedSummary = bedStats.reduce((acc, b) => {
        acc[b.status] = b._count.id;
        return acc;
      }, {} as Record<string, number>);

      return sendSuccess(res, {
        patients: { total: totalPatients },
        staff: { total: totalStaff, doctors: totalDoctors },
        appointments: { today: todayAppointments },
        admissions: { active: activeAdmissions },
        beds: { ...bedSummary },
        billing: { pendingBills },
        laboratory: { pendingOrders: pendingLabOrders },
        emergency: { today: emergencyToday },
        surgery: { today: todaySurgeries },
      }, 'Dashboard stats retrieved');
    } catch (error) { next(error); }
  }
}
