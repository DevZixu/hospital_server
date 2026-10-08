import { Router } from 'express';
import { StaffController } from '../controllers/staff.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/doctors', StaffController.getDoctors);

router.post('/', authorize('SUPER_ADMIN', 'ADMIN'), StaffController.create);
router.get('/', StaffController.findAll);
router.get('/:id', StaffController.findOne);
router.patch('/:id', authorize('SUPER_ADMIN', 'ADMIN'), StaffController.update);
router.delete('/:id', authorize('SUPER_ADMIN', 'ADMIN'), StaffController.deactivate);

router.post('/:id/shifts', authorize('ADMIN', 'DOCTOR', 'NURSE'), StaffController.createShift);
router.get('/:id/shifts', StaffController.getShifts);

export default router;
