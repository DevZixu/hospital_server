import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { all, and, or } from '@prisma/orm-postgres/orm-client';
import type { TimestampString } from '@prisma/orm-postgres/target/codec-types';
import { AppError, NotFoundError } from '../utils/errors';
import { sendSuccess, sendCreated, getPaginationParams, buildPaginationMeta } from '../utils/response';
import { generateBillNo, generatePaymentNo } from '../utils/helpers';
import { logAudit } from '../middleware/audit.middleware';
import { BillStatus } from '../prisma/enums';

const toTimestampString = (value: Date): TimestampString<3> =>
  value.toISOString() as TimestampString<3>;

const findBill = (id: string) =>
  db.orm.public.Bill.where((bill) => or(bill.id.eq(id), bill.billNo.eq(id))).first();

export class BillingController {
  /**
   * POST /billing/bills
   */
  static async createBill(req: Request, res: Response, next: NextFunction) {
    try {
      const { patientId, admissionId, items, notes, dueDate, discountAmount = 0, taxAmount = 0 } = req.body;

      const patient = await db.orm.public.Patient.where((record) =>
        or(record.id.eq(patientId), record.patientId.eq(patientId))
      ).first();
      if (!patient) throw new NotFoundError('Patient not found');

      const totalAmount = items.reduce(
        (sum: number, item: { quantity: number; unitPrice: number }) =>
          sum + item.quantity * item.unitPrice, 0
      );
      const netAmount = totalAmount - discountAmount + taxAmount;

      const created = await db.orm.public.Bill.create({
          billNo: generateBillNo(),
          patientId: patient.id,
          admissionId,
          totalAmount,
          discountAmount,
          taxAmount,
          netAmount,
          balanceAmount: netAmount,
          notes,
          dueDate: dueDate ? toTimestampString(new Date(dueDate)) : undefined,
          items: (billItems) => billItems.create(items.map((item: {
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
            }))),
      });
      const bill = await db.orm.public.Bill
        .include('patient', (record) => record.select('firstName', 'lastName', 'patientId'))
        .include('items')
        .where({ id: created.id })
        .first();
      if (!bill) throw new NotFoundError('Bill could not be created');

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

      const query = db.orm.public.Bill.where((bill) =>
        and(
          patientId ? bill.patientId.eq(patientId as string) : all(),
          status ? bill.status.eq(status as BillStatus) : all()
        )
      );

      const [total, bills] = await Promise.all([
        query.aggregate((aggregate) => ({ total: aggregate.count() })),
        query
          .include('patient', (record) => record.select('firstName', 'lastName', 'patientId'))
          .include('items')
          .include('payments')
          .orderBy((bill) => bill.createdAt.desc())
          .offset(skip)
          .limit(limit)
          .all(),
      ]);

      return sendSuccess(res, bills, 'Bills retrieved', 200, buildPaginationMeta(total.total, page, limit));
    } catch (error) { next(error); }
  }

  /**
   * GET /billing/bills/:id
   */
  static async getBill(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const bill = await db.orm.public.Bill
        .include('patient')
        .include('items')
        .include('payments')
        .include('insurances', (claims) => claims.include('insurance'))
        .where((record) => or(record.id.eq(id), record.billNo.eq(id)))
        .first();
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

      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new AppError('Payment amount must be a positive number', 400);
      }

      const payment = await db.transaction(async (tx) => {
        const bill = await tx.orm.public.Bill.where((record) =>
          or(record.id.eq(id), record.billNo.eq(id))
        ).first();
        if (!bill) throw new NotFoundError('Bill not found');
        const balance = bill.netAmount - bill.paidAmount;
        if (amount > balance) throw new AppError('Payment exceeds the outstanding balance', 409);

        const newPaid = bill.paidAmount + amount;
        const newBalance = bill.netAmount - newPaid;
        const newStatus = newBalance <= 0 ? BillStatus.PAID : BillStatus.PARTIAL;
        const createdPayment = await tx.orm.public.Payment.create({
            paymentNo: generatePaymentNo(),
            billId: bill.id,
            amount,
            method,
            reference,
            notes,
            processedBy: req.user?.userId,
        });
        await tx.orm.public.Bill.where({ id: bill.id }).update({
            paidAmount: newPaid,
            balanceAmount: Math.max(0, newBalance),
            status: newStatus,
        });
        return createdPayment;
      });

      await logAudit(req.user?.userId, 'PAYMENT', 'bill', payment.billId, null, payment);
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

      const bill = await findBill(id);
      if (!bill) throw new NotFoundError('Bill not found');

      const insurance = await db.orm.public.Insurance.where({ id: insuranceId }).first();
      if (!insurance) throw new NotFoundError('Insurance not found');

      const claim = await db.orm.public.BillInsurance
        .include('insurance')
        .create({
          billId: bill.id,
          insuranceId,
          claimNo,
          claimedAmount,
          submittedAt: toTimestampString(new Date()),
      });

      await db.orm.public.Bill.where({ id: bill.id }).update({ status: BillStatus.INSURANCE_PENDING });

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

      const [bills, revenue, pendingBills, overdueCount] = await Promise.all([
        db.orm.public.Bill.where((bill) =>
          and(bill.createdAt.gte(toTimestampString(start)), bill.createdAt.lte(toTimestampString(end)))
        ).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Payment.where((payment) =>
          and(payment.processedAt.gte(toTimestampString(start)), payment.processedAt.lte(toTimestampString(end)))
        ).aggregate((aggregate) => ({ amount: aggregate.sum('amount') })),
        db.orm.public.Bill.where({ status: BillStatus.PENDING }).aggregate((aggregate) => ({ total: aggregate.count() })),
        db.orm.public.Bill.where({ status: BillStatus.OVERDUE }).aggregate((aggregate) => ({ total: aggregate.count() })),
      ]);

      return sendSuccess(res, {
        totalBills: bills.total,
        totalRevenue: revenue.amount || 0,
        pendingBills: pendingBills.total,
        overdueCount: overdueCount.total,
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

      const bill = await findBill(id);
      if (!bill) throw new NotFoundError('Bill not found');

      const updatedDiscount = discountAmount ?? bill.discountAmount;
      const updatedNet = bill.totalAmount - updatedDiscount + bill.taxAmount;

      const updated = await db.orm.public.Bill.where({ id: bill.id }).update({
          discountAmount: updatedDiscount,
          netAmount: updatedNet,
          balanceAmount: updatedNet - bill.paidAmount,
          notes,
          dueDate: dueDate ? toTimestampString(new Date(dueDate)) : undefined,
          status,
      });
      if (!updated) throw new NotFoundError('Bill not found');

      return sendSuccess(res, updated, 'Bill updated');
    } catch (error) { next(error); }
  }
}
