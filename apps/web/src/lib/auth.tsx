import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch, login as loginRequest } from "./api";
import type { User } from "./types";

type AuthContextType = {
  token: string | null;
  user: User | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = "agentfoundry.token";
const USER_KEY = "agentfoundry.user";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    apiFetch<{ user: User }>("/auth/me", {}, token)
      .then((payload) => {
        setUser(payload.user);
        localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
      })
      .catch(() => {
        setToken(null);
        setUser(null);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const value = useMemo<AuthContextType>(
    () => ({
      token,
      user,
      loading,
      async login(username: string, password: string) {
        const payload = await loginRequest(username, password);
        setToken(payload.token);
        setUser(payload.user);
        localStorage.setItem(TOKEN_KEY, payload.token);
        localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
      },
      logout() {
        setToken(null);
        setUser(null);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      }
    }),
    [token, user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}