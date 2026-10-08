import { Router } from 'express';
import { LaboratoryController } from '../controllers/laboratory.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

// Lab test catalog
router.post('/tests', authorize('ADMIN', 'LAB_TECHNICIAN'), LaboratoryController.createLabTest);
router.get('/tests', LaboratoryController.getLabTests);
router.patch('/tests/:id', authorize('ADMIN', 'LAB_TECHNICIAN'), LaboratoryController.updateLabTest);

// Orders
router.post('/orders', authorize('DOCTOR'), LaboratoryController.createOrder);
router.get('/orders', LaboratoryController.getOrders);
router.get('/orders/:id', LaboratoryController.getOrder);
router.get('/orders/:id/report', LaboratoryController.getReport);
router.patch('/orders/:id/items/:itemId/collect', authorize('LAB_TECHNICIAN', 'NURSE'), LaboratoryController.collectSample);
router.patch('/orders/:id/items/:itemId/result', authorize('LAB_TECHNICIAN'), LaboratoryController.enterResult);

export default router;
