import { Router } from 'express';
import { DocumentController } from '../controllers/misc.controller';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { uploadDocument } from '../middleware/upload.middleware';

const router = Router();

router.use(authenticate);

router.post('/:patientId/upload', authorize('ADMIN', 'DOCTOR', 'NURSE'), uploadDocument.single('file'), DocumentController.upload);
router.get('/:patientId', DocumentController.getForPatient);

export default router;