import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateBillNo, generatePaymentNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { BillStatus } from '@prisma/client';

export class BillingController {
  /**
   * POST /billing/bills
   */
  static async createBill(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId, admissionId, items, notes, dueDate, discountAmount = 0, taxAmount = 0 } = req.body;

      const patient = await prisma.patient.findFirst({
        where: { OR: [{ id: patientId }, { patientId }] },
      });
      if (!patient) throw new NotFoundError('Patient not found');

      const totalAmount = items.reduce(
        (sum: number, item: { quantity: number; unitPrice: number }) =>
          sum + item.quantity * item.unitPrice, 0
      );
      const netAmount = totalAmount - discountAmount + taxAmount;

      const bill = await prisma.bill.create({
        data: {
          billNo: generateBillNo(),
          patientId: patient.id,
          admissionId,
          totalAmount,
          discountAmount,
          taxAmount,
          netAmount,
          balanceAmount: netAmount,
          notes,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          items: {
            create: items.map((item: {
              description: string; category: string;
              quantity: number; unitPrice: number; discount?: number; notes?: string;
            }) => ({
              description: item.description,
              category: item.category,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.quantity * item.unitPrice,
              discount: item.discount || 0,
              notes: item.notes,
            })),
          },
        },
        include: {
          patient: { select: { firstName: true, lastName: true, patientId: true } },
          items: true,
        },
      });

      await logAudit(req.user?.userId, 'CREATE_BILL', 'bill', bill.id, null, bill);
      return sendCreated(res, bill, 'Bill created');
    } catch (error) { next(error); }
  }

  /**
   * GET /billing/bills
   */
  static async getBills(req: Request, res: Response, next: NextFunction) {
    try {
      const { page, limit, skip } = getPaginationParams(
        req.query.page as string, req.query.limit as string
      );
      const { patientId, status } = req.query;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (status) where.status = status;

      const [total, bills] = await Promise.all([
        prisma.bill.count({ where }),
        prisma.bill.findMany({
          where, skip, take: limit, orderBy: { createdAt: 'desc' },
          include: {
            patient: { select: { firstName: true, lastName: true, patientId: true } },
            items: true,
            payments: true,
          },
        }),
      ]);

      return sendSuccess(res, bills, 'Bills retrieved', 200, buildPaginationMeta(total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /billing/bills/:id
   */
  static async getBill(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const bill = await prisma.bill.findFirst({
        where: { OR: [{ id }, { billNo: id }] },
        include: {
          patient: true,
          items: true,
          payments: true,
          insurances: { include: { insurance: true } },
        },
      });
      if (!bill) throw new NotFoundError('Bill not found');
      return sendSuccess(res, bill);
    } catch (error) { next(error); }
  }

  /**
   * POST /billing/bills/:id/payment
   */
  static async recordPayment(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { amount, method, reference, notes } = req.body;

      const bill = await prisma.bill.findFirst({
        where: { OR: [{ id }, { billNo: id }] },
      });
      if (!bill) throw new NotFoundError('Bill not found');

      const newPaid = bill.paidAmount + amount;
      const newBalance = bill.netAmount - newPaid;
      const newStatus = newBalance <= 0 ? BillStatus.PAID :
                        newPaid > 0 ? BillStatus.PARTIAL : bill.status;

      const [payment] = await prisma.$transaction([
        prisma.payment.create({
          data: {
            paymentNo: generatePaymentNo(),
            billId: bill.id,
            amount,
            method,
            reference,
            notes,
            processedBy: req.user?.userId,
          },
        }),
        prisma.bill.update({
          where: { id: bill.id },
          data: {
            paidAmount: newPaid,
            balanceAmount: Math.max(0, newBalance),
            status: newStatus,
          },
        }),
      ]);

      await logAudit(req.user?.userId, 'PAYMENT', 'bill', bill.id, null, payment);
      return sendCreated(res, payment, 'Payment recorded');
    } catch (error) { next(error); }
  }

  /**
   * POST /billing/bills/:id/insurance-claim
   */
  static async submitInsuranceClaim(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { insuranceId, claimedAmount, claimNo } = req.body;

      const bill = await prisma.bill.findFirst({
        where: { OR: [{ id }, { billNo: id }] },
      });
      if (!bill) throw new NotFoundError('Bill not found');

      const insurance = await prisma.insurance.findUnique({ where: { id: insuranceId } });
      if (!insurance) throw new NotFoundError('Insurance not found');

      const claim = await prisma.billInsurance.create({
        data: {
          billId: bill.id,
          insuranceId,
          claimNo,
          claimedAmount,
          submittedAt: new Date(),
        },
        include: { insurance: true },
      });

      await prisma.bill.update({
        where: { id: bill.id },
        data: { status: BillStatus.INSURANCE_PENDING },
      });

      return sendCreated(res, claim, 'Insurance claim submitted');
    } catch (error) { next(error); }
  }

  /**
   * GET /billing/stats
   */
  static async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const { startDate, endDate } = req.query;
      const start = startDate ? new Date(startDate as string) : new Date(new Date().setDate(1));
      const end = endDate ? new Date(endDate as string) : new Date();

      const [totalBills, totalRevenue, pendingBills, overdueCount] = await Promise.all([
        prisma.bill.count({ where: { createdAt: { gte: start, lte: end } } }),
        prisma.payment.aggregate({
          where: { processedAt: { gte: start, lte: end } },
          _sum: { amount: true },
        }),
        prisma.bill.count({ where: { status: BillStatus.PENDING } }),
        prisma.bill.count({ where: { status: BillStatus.OVERDUE } }),
      ]);

      return sendSuccess(res, {
        totalBills,
        totalRevenue: totalRevenue._sum.amount || 0,
        pendingBills,
        overdueCount,
        period: { start, end },
      }, 'Billing stats retrieved');
    } catch (error) { next(error); }
  }

  /**
   * PATCH /billing/bills/:id
   */
  static async updateBill(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { discountAmount, notes, dueDate, status } = req.body;

      const bill = await prisma.bill.findFirst({
        where: { OR: [{ id }, { billNo: id }] },
      });
      if (!bill) throw new NotFoundError('Bill not found');

      const updatedDiscount = discountAmount ?? bill.discountAmount;
      const updatedNet = bill.totalAmount - updatedDiscount + bill.taxAmount;

      const updated = await prisma.bill.update({
        where: { id: bill.id },
        data: {
          discountAmount: updatedDiscount,
          netAmount: updatedNet,
          balanceAmount: updatedNet - bill.paidAmount,
          notes,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          status,
        },
      });

      return sendSuccess(res, updated, 'Bill updated');
    } catch (error) { next(error); }
  }
}
