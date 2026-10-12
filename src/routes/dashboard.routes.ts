import { Router } from 'express';
import { DashboardController } from '../controllers/misc.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/stats', DashboardController.getStats);

export default router;