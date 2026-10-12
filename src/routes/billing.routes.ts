import { Router } from 'express';
import { BillingController } from '../controllers/billing.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/stats', BillingController.getStats);

router.post('/bills', authorize('ADMIN', 'BILLING_STAFF'), BillingController.createBill);
router.get('/bills', BillingController.getBills);
router.get('/bills/:id', BillingController.getBill);
router.patch('/bills/:id', authorize('ADMIN', 'BILLING_STAFF'), BillingController.updateBill);
router.post('/bills/:id/payment', authorize('ADMIN', 'BILLING_STAFF'), BillingController.recordPayment);
router.post('/bills/:id/insurance-claim', authorize('ADMIN', 'BILLING_STAFF'), BillingController.submitInsuranceClaim);

export default router;