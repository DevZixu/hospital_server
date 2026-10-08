import { Router } from 'express';
import { AppointmentController } from '../controllers/appointment.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN', 'RECEPTIONIST', 'DOCTOR', 'PATIENT'), AppointmentController.create);
router.get('/', AppointmentController.findAll);
router.get('/doctor/:doctorId/availability', AppointmentController.getDoctorAvailability);
router.get('/:id', AppointmentController.findOne);
router.patch('/:id/status', AppointmentController.updateStatus);
router.patch('/:id/reschedule', AppointmentController.reschedule);

export default router;
