'use client';

import React, { useEffect, useRef, useState } from 'react';

/**
 * What to ask the user. Set `defaultValue` to get a text field (the
 * `window.prompt` case); leave it off for a plain yes/no (the `window.confirm`
 * case). `onConfirm` receives the trimmed, non-empty text.
 */
export type DialogRequest = {
  title: string;
  body?: string;
  defaultValue?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
};

/**
 * In-app stand-in for `window.prompt` / `window.confirm`. Native dialogs are
 * removed in embedded browsers (VS Code's Simple Browser, sandboxed iframes),
 * where calling them throws and the action dies silently.
 *
 * Mount it only while a request is open — it keeps its own field state and
 * relies on unmounting to reset.
 */
export default function Dialog({
  request,
  onClose,
}: {
  request: DialogRequest;
  onClose: () => void;
}) {
  const wantsInput = request.defaultValue !== undefined;
  const [value, setValue] = useState(request.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocked = wantsInput && value.trim() === '';

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    onClose();
    void request.onConfirm(value.trim());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onSubmit={submit}
        className="glass-panel w-full max-w-sm rounded-xl p-5 space-y-4"
      >
        <div className="space-y-1.5">
          <h2 className="text-sm font-bold text-white">{request.title}</h2>
          {request.body && <p className="text-xs text-gray-400 leading-snug">{request.body}</p>}
        </div>

        {wantsInput && (
          <input
            ref={inputRef}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="glass-input w-full text-xs"
          />
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-xs font-semibold text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={blocked}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed ${
              request.destructive
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-gradient-to-r from-cyan-500 to-emerald-500'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
