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
