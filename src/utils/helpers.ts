import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a unique patient ID like PAT-20241001-0001
 */
export const generatePatientId = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `PAT-${dateStr}-${random}`;
};

/**
 * Generate a unique staff ID like STF-20241001-0001
 */
export const generateStaffId = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `STF-${dateStr}-${random}`;
};

export const generateAppointmentNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `APT-${dateStr}-${random}`;
};

export const generateAdmissionNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `ADM-${dateStr}-${random}`;
};

export const generateRecordNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `MR-${dateStr}-${random}`;
};

export const generatePrescriptionNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `RX-${dateStr}-${random}`;
};

export const generateLabOrderNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `LAB-${dateStr}-${random}`;
};

export const generateRadiologyOrderNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `RAD-${dateStr}-${random}`;
};

export const generateBillNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `BILL-${dateStr}-${random}`;
};

export const generatePaymentNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `PAY-${dateStr}-${random}`;
};

export const generateSurgeryNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `SUR-${dateStr}-${random}`;
};

export const generateEmergencyVisitNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `EM-${dateStr}-${random}`;
};

export const generateReferralNo = (): string => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 90000 + 10000);
  return `REF-${dateStr}-${random}`;
};

export const generateToken = (): string => uuidv4().replace(/-/g, '');

export const calculateAge = (dateOfBirth: Date): number => {
  const today = new Date();
  const birthDate = new Date(dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

export const calculateBMI = (weightKg: number, heightCm: number): number => {
  const heightM = heightCm / 100;
  return parseFloat((weightKg / (heightM * heightM)).toFixed(1));
};
