// API types for /api/v1 (mirrors backend zod schemas + service outputs).
// Will be replaced by OpenAPI-generated types (gen:api) in a later milestone.

export type CareRole = 'customer' | 'caregiver' | 'admin';

export interface CareUser {
  id: string;
  phone: string;
  email: string | null;
  role: CareRole;
  status: 'active' | 'suspended' | 'pending_verification';
  line_user_id: string | null;
}

export interface AuthSession {
  user: CareUser;
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

export interface OtpRequestResult {
  phone: string;
  purpose: 'register' | 'login' | 'reset';
  expires_in: number;
  dev_otp?: string; // mock SMS provider in dev only
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Medication {
  name: string;
  dose?: string;
  schedule?: string;
}

export type Mobility = 'walk' | 'cane' | 'walker' | 'wheelchair' | 'bedridden';

export interface ElderSummary {
  id: string;
  full_name: string;
  nickname: string | null;
  birth_date: string | null;
  gender: 'male' | 'female' | 'other' | null;
  mobility: Mobility | null;
  primary_hospital: string | null;
  photo_url: string | null;
}

export interface ElderProfile extends ElderSummary {
  blood_type: string | null;
  weight_kg: number | null;
  height_cm: number | null;
  chronic_conditions: string[];
  medications: Medication[];
  allergies: string[];
  home_address: string | null;
  home_location: LatLng | null;
  special_notes: string | null;
  consent_version: string;
  created_at: string;
  updated_at: string;
}

export interface ElderInput {
  full_name: string;
  nickname?: string | null;
  birth_date?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  blood_type?: string | null;
  weight_kg?: number | null;
  height_cm?: number | null;
  chronic_conditions?: string[];
  medications?: Medication[];
  allergies?: string[];
  mobility?: Mobility | null;
  primary_hospital?: string | null;
  home_address?: string | null;
  home_location?: LatLng | null;
  special_notes?: string | null;
  consent_accepted?: boolean;
}

export type CaregiverBackground =
  | 'nurse_retired'
  | 'nurse_assistant'
  | 'health_student'
  | 'trained_general';

export interface CaregiverProfileInput {
  full_name: string;
  birth_date?: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  id_card_number?: string;
  background?: CaregiverBackground | null;
  languages?: ('th' | 'en')[];
  service_area?: { lat: number; lng: number; radius_km: number } | null;
  base_rate_half_day_baht?: number;
  base_rate_full_day_baht?: number;
}

export interface CaregiverPublicProfile {
  full_name: string;
  birth_date: string | null;
  gender: string | null;
  has_photo: boolean;
  has_id_card_number: boolean;
  background: CaregiverBackground | null;
  certificates: { type: string; uploaded_at: string; verified_at: string | null }[];
  languages: string[];
  service_area: { lat: number; lng: number; radius_km: number | null } | null;
  base_rate_half_day_satang: number | null;
  base_rate_full_day_satang: number | null;
  verification_status: VerificationStatus;
  verification_note: string | null;
  verified_badge: boolean;
}

export type VerificationStatus = 'pending' | 'documents_submitted' | 'verified' | 'rejected';

export type DocumentType = 'id_card' | 'certificate' | 'photo';

export interface DocumentUploadResult {
  type: DocumentType;
  uploaded_at: string;
  preview_url: string | null;
  verification_status: VerificationStatus;
}

export interface OnboardStatus {
  verification_status: VerificationStatus;
  verification_note: string | null;
  profile?: CaregiverPublicProfile;
  photo_signed_url?: string | null;
  checklist: {
    profile_complete: boolean;
    id_card_number: boolean;
    service_area: boolean;
    rates: boolean;
    documents: { id_card: boolean; photo: boolean; certificate: boolean };
  };
}
