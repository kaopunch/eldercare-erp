// Typed endpoint functions for /api/v1 — shared by both portals.
// portal = 'customer' | 'caregiver' selects the API prefix.
import { api, post, patch, del } from './client';
import type {
  AuthSession,
  OtpRequestResult,
  ElderSummary,
  ElderProfile,
  ElderInput,
  CaregiverProfileInput,
  CaregiverPublicProfile,
  DocumentType,
  DocumentUploadResult,
  OnboardStatus,
} from './types';

export type Portal = 'customer' | 'caregiver';

const prefix = (portal: Portal) => `/api/v1/${portal}`;

// ===== auth (both portals) =====

export const authApi = {
  register(portal: Portal, phone: string): Promise<OtpRequestResult> {
    return post(`${prefix(portal)}/auth/register`, { phone });
  },
  verifyOtpAndRegister(
    portal: Portal,
    input: { phone: string; code: string; password: string },
  ): Promise<AuthSession> {
    return post(`${prefix(portal)}/auth/otp/verify`, input);
  },
  login(portal: Portal, input: { phone: string; password: string }): Promise<AuthSession> {
    return post(`${prefix(portal)}/auth/login`, input);
  },
  refresh(portal: Portal, refreshToken: string): Promise<AuthSession> {
    return post(`${prefix(portal)}/auth/refresh`, { refresh_token: refreshToken });
  },
  logout(portal: Portal, refreshToken: string): Promise<{ ok: boolean }> {
    return post(`${prefix(portal)}/auth/logout`, { refresh_token: refreshToken });
  },
};

// ===== customer: elders =====

export const eldersApi = {
  list(): Promise<ElderSummary[]> {
    return api('/api/v1/customer/elders');
  },
  get(id: string): Promise<ElderProfile> {
    return api(`/api/v1/customer/elders/${id}`);
  },
  create(input: ElderInput): Promise<ElderProfile> {
    return post('/api/v1/customer/elders', input);
  },
  update(id: string, input: Partial<ElderInput>): Promise<ElderProfile> {
    return patch(`/api/v1/customer/elders/${id}`, input);
  },
  remove(id: string): Promise<{ ok: boolean }> {
    return del(`/api/v1/customer/elders/${id}`);
  },
};

// ===== caregiver: onboarding =====

export const onboardApi = {
  saveProfile(input: CaregiverProfileInput): Promise<CaregiverPublicProfile> {
    return post('/api/v1/caregiver/onboard/profile', input);
  },
  async uploadDocument(type: DocumentType, file: File): Promise<DocumentUploadResult> {
    const dataBase64 = await fileToBase64(file);
    return post('/api/v1/caregiver/onboard/documents', {
      type,
      file_name: file.name,
      content_type: file.type,
      data_base64: dataBase64,
    });
  },
  status(): Promise<OnboardStatus> {
    return api('/api/v1/caregiver/onboard/status');
  },
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ===== customer: bookings (M2) =====

import type {
  QuoteInput,
  Quote,
  BookingCreateInput,
  Booking,
  PayResult,
  CancelPreview,
  BookingEvent,
} from './types';

export const bookingsApi = {
  quote(input: QuoteInput): Promise<Quote> {
    return post('/api/v1/customer/bookings/quote', input);
  },
  create(input: BookingCreateInput): Promise<{ booking: Booking; quote: Quote }> {
    return post('/api/v1/customer/bookings', input);
  },
  list(scope?: 'upcoming' | 'past'): Promise<Booking[]> {
    return api(`/api/v1/customer/bookings${scope ? `?scope=${scope}` : ''}`);
  },
  get(id: string): Promise<Booking> {
    return api(`/api/v1/customer/bookings/${id}`);
  },
  pay(id: string, input: { method: 'promptpay' | 'card' | 'mock'; card_token?: string }): Promise<PayResult> {
    return post(`/api/v1/customer/bookings/${id}/pay`, input);
  },
  cancelPreview(id: string): Promise<CancelPreview> {
    return api(`/api/v1/customer/bookings/${id}/cancel-preview`);
  },
  cancel(id: string, reason?: string): Promise<{ booking: Booking; refund_satang: number | null }> {
    return post(`/api/v1/customer/bookings/${id}/cancel`, { reason });
  },
  events(id: string): Promise<BookingEvent[]> {
    return api(`/api/v1/customer/bookings/${id}/events`);
  },
};

// ===== M3: availability + jobs (caregiver), confirm (customer) =====

import type { AvailabilityDay, JobOffer, CaregiverJob } from './types';

export const availabilityApi = {
  list(from?: string, to?: string): Promise<AvailabilityDay[]> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return api(`/api/v1/caregiver/availability${query ? `?${query}` : ''}`);
  },
  save(days: AvailabilityDay[]): Promise<AvailabilityDay[]> {
    return api('/api/v1/caregiver/availability', { method: 'PUT', body: JSON.stringify({ days }) });
  },
};

export const jobsApi = {
  offers(): Promise<JobOffer[]> {
    return api('/api/v1/caregiver/jobs/offers');
  },
  accept(bookingId: string): Promise<CaregiverJob> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/accept`, {});
  },
  active(): Promise<CaregiverJob[]> {
    return api('/api/v1/caregiver/jobs/active');
  },
  history(): Promise<CaregiverJob[]> {
    return api('/api/v1/caregiver/jobs/history');
  },
};

export const bookingConfirmApi = {
  confirm(bookingId: string): Promise<Booking> {
    return post(`/api/v1/customer/bookings/${bookingId}/confirm`, {});
  },
};

// ===== M4: active job (caregiver) + tracking (customer) =====

import type { ElderJobCard, HealthRecordInput, PhotoUpload, TrackSnapshot, LatLng as Point } from './types';

export const activeJobApi = {
  get(bookingId: string): Promise<CaregiverJob & { elder?: ElderJobCard }> {
    return api(`/api/v1/caregiver/jobs/${bookingId}`);
  },
  checkin(bookingId: string, photo: PhotoUpload, location: Point): Promise<{ status: string }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/checkin`, { photo, location });
  },
  arrive(bookingId: string, location: Point | null): Promise<{ status: string }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/arrive`, { location });
  },
  healthRecord(bookingId: string, input: HealthRecordInput): Promise<{ id: string }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/health-record`, input);
  },
  departing(bookingId: string, location: Point | null): Promise<{ status: string }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/departing`, { location });
  },
  checkout(bookingId: string, location: Point): Promise<{ status: string }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/checkout`, { location });
  },
  sos(bookingId: string, location: Point | null, note?: string): Promise<{ ok: boolean }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/sos`, { location, note });
  },
  ping(bookingId: string, lat: number, lng: number, accuracyM?: number | null): Promise<{ stored: boolean }> {
    return post(`/api/v1/caregiver/jobs/${bookingId}/location`, { lat, lng, accuracy_m: accuracyM ?? null });
  },
};

export const trackApi = {
  snapshot(bookingId: string): Promise<TrackSnapshot> {
    return api(`/api/v1/customer/bookings/${bookingId}/track`);
  },
  confirmComplete(bookingId: string): Promise<Booking> {
    return post(`/api/v1/customer/bookings/${bookingId}/confirm-complete`, {});
  },
  wsUrl(bookingId: string, token: string): string {
    const base = (import.meta.env.VITE_API_BASE_URL as string) || window.location.origin;
    return `${base.replace(/^http/, 'ws')}/ws/care/track/${bookingId}?token=${encodeURIComponent(token)}`;
  },
};
