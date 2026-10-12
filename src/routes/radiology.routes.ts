import { Router } from 'express';
import { RadiologyController } from '../controllers/radiology.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/orders', authorize('ADMIN', 'DOCTOR'), RadiologyController.createOrder);
router.get('/orders', RadiologyController.getOrders);
router.get('/orders/:id', RadiologyController.getOrder);
router.patch('/orders/:id/perform', authorize('ADMIN', 'RADIOLOGIST'), RadiologyController.markPerformed);
router.patch('/orders/:id/report', authorize('ADMIN', 'RADIOLOGIST'), RadiologyController.submitReport);

export default router;