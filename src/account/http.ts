/** JSON calls to this app's own server (same origin; cookies carry the session). */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
  /** A message suitable for showing to the user when !ok. */
  message: string;
}

export async function call<T = any>(path: string, init: { method?: string; json?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: init.json !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, data: null as T, message: 'Could not reach the server. Check your connection and try again.' };
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const message = res.ok ? '' : (data?.message ?? data?.error?.message ?? friendly(res.status));
  return { ok: res.ok, status: res.status, data, message };
}

function friendly(status: number): string {
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return 'That item no longer exists.';
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  return 'Something went wrong. Try again.';
}
