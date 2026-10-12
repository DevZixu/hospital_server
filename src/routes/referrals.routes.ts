import { Router } from 'express';
import { ReferralController } from '../controllers/misc.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN', 'DOCTOR'), ReferralController.create);
router.get('/', ReferralController.findAll);
router.patch('/:id/status', authorize('ADMIN', 'DOCTOR'), ReferralController.updateStatus);

export default router;