import { Router } from 'express';
import { AdmissionController } from '../controllers/admission.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN', 'DOCTOR', 'RECEPTIONIST', 'NURSE'), AdmissionController.admit);
router.get('/', AdmissionController.findAll);
router.get('/:id', AdmissionController.findOne);
router.post('/:id/discharge', authorize('DOCTOR', 'ADMIN'), AdmissionController.discharge);
router.post('/:id/transfer', authorize('DOCTOR', 'ADMIN', 'NURSE'), AdmissionController.transfer);

export default router;
