import { Router } from 'express';
import { WardController } from '../controllers/misc.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN'), WardController.createWard);
router.get('/', WardController.getWards);
router.post('/:wardId/beds', authorize('ADMIN'), WardController.createBed);
router.get('/:wardId/beds', WardController.getBeds);

export default router;