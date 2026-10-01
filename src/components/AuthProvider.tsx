'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { createClient } from '../lib/supabase';
import { setToken } from '../lib/api';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  authError: string | null;
}

interface AuthContextValue extends AuthState {
  signIn: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Authentication request failed.';
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }

  return context;
}

export default function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
    authError: null,
  });

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    let active = true;
    let authRevision = 0;

    function applySession(session: Session | null) {
      if (!active) return;

      setToken(session?.access_token ?? null);
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
        authError: null,
      });
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;

      authRevision += 1;
      applySession(session);
    });

    // A newer auth event takes precedence over this initial lookup.
    const initialRevision = authRevision;

    async function restoreSession() {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (!active || authRevision !== initialRevision) return;
        if (error) throw error;

        applySession(data.session);
      } catch (cause) {
        if (!active || authRevision !== initialRevision) return;

        setToken(null);
        setState({
          user: null,
          session: null,
          loading: false,
          authError: errorMessage(cause),
        });
      }
    }

    void restoreSession();

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        return { error: error?.message ?? null };
      } catch (cause) {
        return { error: errorMessage(cause) };
      }
    },
    [supabase],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      try {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });

        return { error: error?.message ?? null };
      } catch (cause) {
        return { error: errorMessage(cause) };
      }
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();

    if (error) throw error;
  }, [supabase]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signUp, signOut }),
    [state, signIn, signUp, signOut],
  );

  return (
    <AuthContext.Provider value={value}>
      {state.authError && (
        <p
          role="alert"
          className="border border-red-900 bg-red-950 p-3 text-sm text-red-200"
        >
          Unable to restore your session: {state.authError}.
          {' '}Reload the page to retry.
        </p>
      )}

      {children}
    </AuthContext.Provider>
  );
}