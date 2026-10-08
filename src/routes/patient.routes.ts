import { Router } from 'express';
import { PatientController } from '../controllers/patient.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { uploadProfile } from '../middleware/upload.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('ADMIN', 'RECEPTIONIST', 'DOCTOR', 'NURSE'), PatientController.create);
router.get('/', PatientController.findAll);
router.get('/:id', PatientController.findOne);
router.patch('/:id', authorize('ADMIN', 'RECEPTIONIST', 'DOCTOR'), PatientController.update);
router.delete('/:id', authorize('ADMIN', 'DOCTOR'), PatientController.deactivate);

// Sub-resources
router.get('/:id/medical-history', PatientController.getMedicalHistory);
router.get('/:id/vitals', PatientController.getVitals);
router.get('/:id/admissions', PatientController.getAdmissions);
router.get('/:id/bills', PatientController.getBills);
router.post('/:id/emergency-contacts', PatientController.addEmergencyContact);
router.post('/:id/insurance', PatientController.addInsurance);

export default router;
