import { Router } from 'express';
import { PharmacyController } from '../controllers/pharmacy.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticate);

// Medications
router.post('/medications', authorize('ADMIN', 'PHARMACIST'), PharmacyController.createMedication);
router.get('/medications', PharmacyController.getMedications);
router.get('/medications/:id', PharmacyController.getMedication);
router.patch('/medications/:id', authorize('ADMIN', 'PHARMACIST'), PharmacyController.updateMedication);

// Stock
router.post('/stock', authorize('ADMIN', 'PHARMACIST'), PharmacyController.addStock);
router.get('/stock', PharmacyController.getStock);

// Prescriptions
router.post('/prescriptions', authorize('DOCTOR'), PharmacyController.createPrescription);
router.get('/prescriptions', PharmacyController.getPrescriptions);
router.get('/prescriptions/:id', PharmacyController.getPrescription);
router.post('/prescriptions/:id/dispense', authorize('PHARMACIST'), PharmacyController.dispensePrescription);

export default router;
