import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { apiKeepAlive, apiMe, apiLogout } from '../api/auth.api';
import type { AuthUser } from '../api/types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const KEEPALIVE_INTERVAL_MS = 60_000;
const KEEPALIVE_THRESHOLD_MS = 2 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await apiMe();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!user) return;

    let inFlight = false;

    const runKeepAlive = async (force = false) => {
      if (inFlight) return;
      if (!force && typeof document !== 'undefined' && document.visibilityState !== 'visible')
        return;

      const expiresAtMs = new Date(user.expiresAt).getTime();
      const remainingMs = expiresAtMs - Date.now();
      if (!force && remainingMs > KEEPALIVE_THRESHOLD_MS) return;

      inFlight = true;
      try {
        const nextUser = await apiKeepAlive();
        setUser(nextUser);
      } catch {
        setUser(null);
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void runKeepAlive(false);
    }, KEEPALIVE_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void runKeepAlive(true);
      }
    };

    const onFocus = () => {
      void runKeepAlive(true);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
