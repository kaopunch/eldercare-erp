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

// ===== bookings (M2) =====

export type ServiceType = 'hospital_visit' | 'errand' | 'companion';
export type DurationType = 'half_day' | 'full_day';
export type BookingStatus =
  | 'draft'
  | 'pending_payment'
  | 'searching'
  | 'matched'
  | 'confirmed'
  | 'in_progress_pickup'
  | 'at_destination'
  | 'returning'
  | 'pending_confirmation'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface SpecialRequirements {
  wheelchair?: boolean;
  english?: boolean;
  caregiver_gender?: 'male' | 'female' | null;
}

export interface QuoteInput {
  service_type: ServiceType;
  duration_type: DurationType;
  pickup: LatLng;
  destination: LatLng;
  special_requirements?: SpecialRequirements;
}

export interface Quote {
  service_type: ServiceType;
  duration_type: DurationType;
  distance_km: number;
  breakdown: {
    base_satang: number;
    distance_surcharge_satang: number;
    english_premium_satang: number;
    insurance_fee_satang: number;
  };
  price_total_satang: number;
  platform_fee_satang: number;
  caregiver_payout_satang: number;
  insurance_fee_satang: number;
}

export interface BookingCreateInput {
  elder_profile_id: string;
  service_type: ServiceType;
  duration_type: DurationType;
  scheduled_date: string;
  pickup_time: string;
  pickup_address?: string | null;
  pickup_location?: LatLng | null;
  destination_name: string;
  destination_address?: string | null;
  destination_location: LatLng;
  appointment_detail?: string | null;
  special_requirements?: SpecialRequirements;
}

export interface Booking {
  id: string;
  elder_profile_id: string;
  caregiver_user_id: string | null;
  service_type: ServiceType;
  duration_type: DurationType;
  scheduled_date: string;
  pickup_time: string;
  pickup_address: string | null;
  pickup_location: LatLng | null;
  destination_name: string;
  destination_address: string | null;
  destination_location: LatLng | null;
  appointment_detail: string | null;
  special_requirements: SpecialRequirements;
  distance_km: number | null;
  price_total_satang: number | null;
  platform_fee_satang: number | null;
  insurance_fee_satang: number | null;
  status: BookingStatus;
  payment_expires_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  refund_pct: number | null;
  created_at: string;
  updated_at: string;
  caregiver?: BookingCaregiverInfo;
  search_timed_out?: boolean;
}

export interface PayResult {
  booking: Booking;
  payment_status: 'held_escrow' | 'pending' | 'failed';
  qr_image_url?: string | null;
}

export interface CancelPreview {
  cancellable: boolean;
  paid: boolean;
  refund_pct: number;
  refund_satang: number;
  caregiver_comp_pct: number;
  caregiver_comp_satang: number;
}

export interface BookingEvent {
  id: string;
  event_type: string;
  actor: string;
  lat: number | null;
  lng: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

// ===== M3: matching =====

export interface AvailabilityDay {
  date: string;
  slots: { morning: boolean; afternoon: boolean };
}

export interface JobOffer {
  booking_id: string;
  batch_no: number;
  expires_at: string;
  scheduled_date: string;
  pickup_time: string;
  service_type: ServiceType;
  duration_type: DurationType;
  destination_name: string;
  special_requirements: SpecialRequirements;
  distance_km: number | null;
  payout_satang: number;
  area_approx: LatLng | null;
}

export interface CaregiverJob {
  id: string;
  status: BookingStatus;
  service_type: ServiceType;
  duration_type: DurationType;
  scheduled_date: string;
  pickup_time: string;
  pickup_address: string | null;
  pickup_location: LatLng | null;
  destination_name: string;
  destination_address: string | null;
  destination_location: LatLng | null;
  appointment_detail: string | null;
  special_requirements: SpecialRequirements;
  payout_satang: number | null;
  matched_at: string | null;
}

export interface BookingCaregiverInfo {
  full_name: string;
  gender: string | null;
  rating_avg: number;
  jobs_completed: number;
  verified_badge: boolean;
  phone: string | null;
}
