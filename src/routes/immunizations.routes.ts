import { Router } from 'express';
import { ImmunizationController } from '../controllers/misc.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/:patientId', authorize('ADMIN', 'DOCTOR', 'NURSE'), ImmunizationController.record);
router.get('/:patientId', ImmunizationController.getForPatient);

export default router;