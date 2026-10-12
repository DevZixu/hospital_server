import { Router } from 'express';
import { DepartmentController } from '../controllers/misc.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN'), DepartmentController.create);
router.get('/', DepartmentController.findAll);
router.get('/:id', DepartmentController.findOne);
router.patch('/:id', authorize('ADMIN'), DepartmentController.update);

export default router;