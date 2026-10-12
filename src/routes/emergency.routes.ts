import { Router } from 'express';
import { EmergencyController } from '../controllers/emergency.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/triage', authorize('ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'), EmergencyController.triage);
router.get('/visits', EmergencyController.getVisits);
router.get('/visits/:id', EmergencyController.getVisit);
router.patch('/visits/:id/assign', authorize('ADMIN', 'DOCTOR', 'NURSE'), EmergencyController.assignDoctor);
router.patch('/visits/:id/status', authorize('ADMIN', 'DOCTOR', 'NURSE'), EmergencyController.updateStatus);
router.get('/queue', EmergencyController.getQueue);
router.get('/stats', EmergencyController.getStats);

export default router;