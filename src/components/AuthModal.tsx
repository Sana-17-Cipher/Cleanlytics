'use client';

import React, { useEffect, useCallback, useRef } from 'react';
import { X, Shield, Sparkles, BarChart3, Database } from 'lucide-react';

const GOOGLE_CLIENT_ID = '839744067749-4f4iqilgk72o5emmj50hggi7atqts6k9.apps.googleusercontent.com';

interface AuthUser {
  id: number;
  name: string;
  email: string;
  picture: string | null;
  registered_at: string | null;
  last_login: string | null;
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (user: AuthUser, token: string) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (element: HTMLElement, config: any) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export type { AuthUser };

export default function AuthModal({ isOpen, onClose, onAuthSuccess }: AuthModalProps) {
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const scriptLoadedRef = useRef(false);

  const handleCredentialResponse = useCallback(async (response: any) => {
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: response.credential }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || err.error || 'Authentication failed');
      }

      const data = await res.json();
      // Store token
      localStorage.setItem('cleanytics_token', data.access_token);
      localStorage.setItem('cleanytics_user', JSON.stringify(data.user));
      onAuthSuccess(data.user, data.access_token);
    } catch (err) {
      console.error('Auth error:', err);
      alert('Sign-in failed. Please try again.');
    }
  }, [onAuthSuccess]);

  useEffect(() => {
    if (!isOpen) return;

    const initGoogle = () => {
      if (!window.google || !googleBtnRef.current) return;

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        width: 320,
        text: 'continue_with',
      });
    };

    if (window.google) {
      initGoogle();
    } else if (!scriptLoadedRef.current) {
      scriptLoadedRef.current = true;
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => setTimeout(initGoogle, 100);
      document.head.appendChild(script);
    }
  }, [isOpen, handleCredentialResponse]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 animate-fade-in" style={{ animationDuration: '0.2s' }}>
        <div
          className="rounded-2xl border border-gray-800/60 overflow-hidden"
          style={{
            background: 'linear-gradient(135deg, rgba(9,9,11,0.98), rgba(17,24,39,0.98))',
            boxShadow: '0 25px 80px rgba(0,0,0,0.6), 0 0 60px rgba(6,182,212,0.08)',
          }}
        >
          {/* Close Button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg hover:bg-zinc-800 text-gray-500 hover:text-gray-300 transition z-10"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Header with gradient */}
          <div className="relative px-8 pt-10 pb-6 text-center">
            {/* Decorative glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-24 bg-gradient-to-b from-cyan-500/15 to-transparent rounded-full blur-2xl" />

            <div className="relative">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center shadow-xl shadow-emerald-500/20 mx-auto mb-5">
                <span className="text-black font-black text-2xl tracking-tight">C</span>
              </div>

              <h2 className="text-xl font-extrabold text-white tracking-tight">
                Welcome to CLEANYTICS
              </h2>
              <p className="text-sm text-gray-400 mt-2 max-w-[280px] mx-auto leading-relaxed">
                Sign in to upload datasets, save dashboards, and access your analytics workspace.
              </p>
            </div>
          </div>

          {/* Feature highlights */}
          <div className="px-8 pb-4">
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { icon: Database, label: 'Upload & Store Data' },
                { icon: Shield, label: 'Secure Projects' },
                { icon: BarChart3, label: 'BI Dashboards' },
                { icon: Sparkles, label: 'AI Insights' },
              ].map((feat, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-zinc-900/50 border border-gray-800/40"
                >
                  <feat.icon className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                  <span className="text-[11px] text-gray-400 font-medium">{feat.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Google Sign-In Button */}
          <div className="px-8 py-6 flex flex-col items-center gap-4">
            <div ref={googleBtnRef} className="flex justify-center" />

            <p className="text-[10px] text-gray-600 text-center max-w-[260px] leading-relaxed">
              By signing in, you agree to our Terms of Service. Your data is encrypted and secured.
            </p>
          </div>

          {/* Bottom accent */}
          <div className="h-1 bg-gradient-to-r from-emerald-500 via-cyan-500 to-violet-500" />
        </div>
      </div>
    </div>
  );
}
