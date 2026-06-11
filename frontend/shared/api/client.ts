// Minimal API client wrapper — all raw fetch calls must go through here.
// Will be replaced by an OpenAPI-generated client (npm run gen:api) in M2+.

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';

let accessToken: string | null = null;
let tokenRefresher: (() => Promise<string | null>) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** App registers a callback that exchanges the refresh token for a new access token. */
export function setTokenRefresher(refresher: (() => Promise<string | null>) | null): void {
  tokenRefresher = refresher;
}

async function rawRequest(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, options);
  if (res.status === 401 && tokenRefresher) {
    const renewed = await tokenRefresher();
    if (renewed) {
      accessToken = renewed;
      res = await rawRequest(path, options);
    }
  }
  if (!res.ok) {
    let err: ApiError = { code: 'HTTP_ERROR', message: `HTTP ${res.status}` };
    try {
      err = (await res.json()) as ApiError;
    } catch {
      // keep generic error
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
}
