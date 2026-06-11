// Minimal API client wrapper — all raw fetch calls must go through here.
// Will be replaced by an OpenAPI-generated client (npm run gen:api) in M1+.

export interface ApiError {
  code: string;
  message: string;
}

const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let err: ApiError = { code: 'http_error', message: `HTTP ${res.status}` };
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
