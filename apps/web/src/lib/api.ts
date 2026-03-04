import type { User } from "./types";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token?: string
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  return (await response.text()) as T;
}

export async function login(username: string, password: string) {
  return apiFetch<{ token: string; user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export { API_BASE };