import path from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import admissionRoutes from './routes/admission.routes';
import appointmentRoutes from './routes/appointment.routes';
import authRoutes from './routes/auth.routes';
import laboratoryRoutes from './routes/laboratory.routes';
import medicalRecordRoutes from './routes/medicalRecord.routes';
import patientRoutes from './routes/patient.routes';
import pharmacyRoutes from './routes/pharmacy.routes';
import staffRoutes from './routes/staff.routes';
import { config } from './config/config';
import { errorHandler, notFound } from './middleware/error.middleware';

export const app = express();
const api = `/api/${config.apiVersion}`;

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: config.cors.origins }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
app.use(rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}));
app.use('/uploads', express.static(path.resolve(config.upload.dir)));

app.get('/health', (_req, res) => {
  res.status(200).json({ success: true, status: 'ok' });
});

app.use(`${api}/auth`, authRoutes);
app.use(`${api}/patients`, patientRoutes);
app.use(`${api}/staff`, staffRoutes);
app.use(`${api}/appointments`, appointmentRoutes);
app.use(`${api}/admissions`, admissionRoutes);
app.use(`${api}/medical-records`, medicalRecordRoutes);
app.use(`${api}/laboratory`, laboratoryRoutes);
app.use(`${api}/pharmacy`, pharmacyRoutes);

app.use(notFound);
app.use(errorHandler);