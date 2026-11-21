"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";

const EVENT = "ip:toast";

/** Show a short confirmation (copy actions, saved states). Announced politely to screen readers. */
export function toast(message: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: message }));
}

export function Toaster() {
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev.slice(-2), { id, message: (e as CustomEvent<string>).detail }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2600);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-1.5" aria-live="polite" role="status">
      {items.map((t) => (
        <div key={t.id} className="atlas-in flex items-center gap-2 rounded-lg border border-line bg-panel-3 px-3 py-1.5 text-[12.5px] text-fg shadow-[var(--shadow)]">
          <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> {t.message}
        </div>
      ))}
    </div>
  );
}
