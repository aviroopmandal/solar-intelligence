import { auth } from './firebase.ts';

let activeOrgIdInMemory: string | null = null;

export function setActiveOrgId(orgId: string | null) {
  activeOrgIdInMemory = orgId;
}

export function getActiveOrgId(): string | null {
  return activeOrgIdInMemory;
}

async function getIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('User is not signed in.');
  }
  return await user.getIdToken();
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (activeOrgIdInMemory) {
    headers.set('x-organisation-id', activeOrgIdInMemory);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson?.error) msg = errJson.error;
    } catch {
      // ignore non-json error body
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function downloadAuthorizedFile(path: string, filename: string) {
  const token = await getIdToken();
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  if (activeOrgIdInMemory) {
    headers.set('x-organisation-id', activeOrgIdInMemory);
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
