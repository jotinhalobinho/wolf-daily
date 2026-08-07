const BASE = "/api";

async function request(path: string, options: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // no body / not json
  }
  if (!res.ok) {
    const message = (data && data.error) || `Erro (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export const apiGet = (path: string) => request(path);
export const apiPost = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) });
export const apiPut = (path: string, body: unknown) => request(path, { method: "PUT", body: JSON.stringify(body) });
export const apiPatch = (path: string, body: unknown) => request(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiDelete = (path: string) => request(path, { method: "DELETE" });
