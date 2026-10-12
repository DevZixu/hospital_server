import { Router } from 'express';
import { SurgeryController } from '../controllers/surgery.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN', 'DOCTOR'), SurgeryController.schedule);
router.get('/', SurgeryController.findAll);
router.get('/:id', SurgeryController.findOne);
router.patch('/:id/start', authorize('ADMIN', 'DOCTOR'), SurgeryController.startSurgery);
router.patch('/:id/complete', authorize('ADMIN', 'DOCTOR'), SurgeryController.completeSurgery);
router.patch('/:id/cancel', authorize('ADMIN', 'DOCTOR'), SurgeryController.cancelSurgery);

export default router;