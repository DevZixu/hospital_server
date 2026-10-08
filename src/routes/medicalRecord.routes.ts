import { Router } from 'express';
import { MedicalRecordController } from '../controllers/medicalRecord.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

router.post('/', authorize('DOCTOR'), MedicalRecordController.create);
router.get('/', MedicalRecordController.findAll);
router.get('/:id', MedicalRecordController.findOne);
router.patch('/:id', authorize('DOCTOR'), MedicalRecordController.update);
router.post('/:id/diagnoses', authorize('DOCTOR'), MedicalRecordController.addDiagnosis);
router.post('/:id/vitals', authorize('DOCTOR', 'NURSE'), MedicalRecordController.addVitals);
router.post('/:id/nurse-notes', authorize('NURSE', 'DOCTOR'), MedicalRecordController.addNurseNote);

export default router;
