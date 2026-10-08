export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  DOCTOR: 'DOCTOR',
  NURSE: 'NURSE',
  PHARMACIST: 'PHARMACIST',
  LAB_TECHNICIAN: 'LAB_TECHNICIAN',
  RECEPTIONIST: 'RECEPTIONIST',
  BILLING_STAFF: 'BILLING_STAFF',
  RADIOLOGIST: 'RADIOLOGIST',
  PATIENT: 'PATIENT',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Gender = { MALE: 'MALE', FEMALE: 'FEMALE', OTHER: 'OTHER' } as const;
export type Gender = (typeof Gender)[keyof typeof Gender];

export const BloodGroup = {
  A_POSITIVE: 'A_POSITIVE',
  A_NEGATIVE: 'A_NEGATIVE',
  B_POSITIVE: 'B_POSITIVE',
  B_NEGATIVE: 'B_NEGATIVE',
  AB_POSITIVE: 'AB_POSITIVE',
  AB_NEGATIVE: 'AB_NEGATIVE',
  O_POSITIVE: 'O_POSITIVE',
  O_NEGATIVE: 'O_NEGATIVE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type BloodGroup = (typeof BloodGroup)[keyof typeof BloodGroup];

export const AppointmentStatus = {
  SCHEDULED: 'SCHEDULED', CONFIRMED: 'CONFIRMED', CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW', RESCHEDULED: 'RESCHEDULED',
} as const;
export type AppointmentStatus = (typeof AppointmentStatus)[keyof typeof AppointmentStatus];

export const AppointmentType = {
  CONSULTATION: 'CONSULTATION', FOLLOW_UP: 'FOLLOW_UP', EMERGENCY: 'EMERGENCY',
  ROUTINE_CHECKUP: 'ROUTINE_CHECKUP', SURGERY_PRE_OP: 'SURGERY_PRE_OP',
  SURGERY_POST_OP: 'SURGERY_POST_OP', TELEMEDICINE: 'TELEMEDICINE',
  LAB_REVIEW: 'LAB_REVIEW', VACCINATION: 'VACCINATION', PHYSICAL_THERAPY: 'PHYSICAL_THERAPY',
} as const;
export type AppointmentType = (typeof AppointmentType)[keyof typeof AppointmentType];

export const AdmissionStatus = {
  PENDING: 'PENDING', ADMITTED: 'ADMITTED', TRANSFERRED: 'TRANSFERRED',
  DISCHARGED: 'DISCHARGED', DECEASED: 'DECEASED',
} as const;
export type AdmissionStatus = (typeof AdmissionStatus)[keyof typeof AdmissionStatus];

export const BedStatus = { AVAILABLE: 'AVAILABLE', OCCUPIED: 'OCCUPIED', MAINTENANCE: 'MAINTENANCE', RESERVED: 'RESERVED' } as const;
export type BedStatus = (typeof BedStatus)[keyof typeof BedStatus];

export const PrescriptionStatus = {
  PENDING: 'PENDING', DISPENSED: 'DISPENSED', PARTIALLY_DISPENSED: 'PARTIALLY_DISPENSED',
  CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED',
} as const;
export type PrescriptionStatus = (typeof PrescriptionStatus)[keyof typeof PrescriptionStatus];

export const LabTestStatus = {
  ORDERED: 'ORDERED', SAMPLE_COLLECTED: 'SAMPLE_COLLECTED', IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', REJECTED: 'REJECTED',
} as const;
export type LabTestStatus = (typeof LabTestStatus)[keyof typeof LabTestStatus];

export const BillStatus = {
  PENDING: 'PENDING', PARTIAL: 'PARTIAL', PAID: 'PAID', OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED', INSURANCE_PENDING: 'INSURANCE_PENDING',
} as const;
export type BillStatus = (typeof BillStatus)[keyof typeof BillStatus];

export const EmergencyStatus = {
  TRIAGED: 'TRIAGED', WAITING: 'WAITING', IN_TREATMENT: 'IN_TREATMENT', ADMITTED: 'ADMITTED',
  TRANSFERRED: 'TRANSFERRED', DISCHARGED: 'DISCHARGED', DECEASED: 'DECEASED',
} as const;
export type EmergencyStatus = (typeof EmergencyStatus)[keyof typeof EmergencyStatus];

export const EmergencyPriority = {
  P1_IMMEDIATE: 'P1_IMMEDIATE', P2_URGENT: 'P2_URGENT',
  P3_LESS_URGENT: 'P3_LESS_URGENT', P4_NON_URGENT: 'P4_NON_URGENT',
} as const;
export type EmergencyPriority = (typeof EmergencyPriority)[keyof typeof EmergencyPriority];

export const SurgeryStatus = {
  SCHEDULED: 'SCHEDULED', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED', POSTPONED: 'POSTPONED',
} as const;
export type SurgeryStatus = (typeof SurgeryStatus)[keyof typeof SurgeryStatus];

export const ImagingModality = {
  X_RAY: 'X_RAY', CT_SCAN: 'CT_SCAN', MRI: 'MRI', ULTRASOUND: 'ULTRASOUND',
  ECHO: 'ECHO', ECG: 'ECG', PET_SCAN: 'PET_SCAN', MAMMOGRAPHY: 'MAMMOGRAPHY',
  FLUOROSCOPY: 'FLUOROSCOPY',
} as const;
export type ImagingModality = (typeof ImagingModality)[keyof typeof ImagingModality];

export const RadiologyStatus = {
  ORDERED: 'ORDERED', SCHEDULED: 'SCHEDULED', IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', REPORTED: 'REPORTED',
} as const;
export type RadiologyStatus = (typeof RadiologyStatus)[keyof typeof RadiologyStatus];