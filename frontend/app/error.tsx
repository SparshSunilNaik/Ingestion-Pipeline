"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui";

/** Route-level error boundary: a rendering failure in one page never blanks the whole app. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ui] page crashed:", error);
  }, [error]);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <section role="alert" className="w-full max-w-[520px] rounded-xl border border-line bg-panel p-6">
        <div className="flex items-center gap-2.5 text-bad">
          <TriangleAlert className="h-5 w-5" aria-hidden />
          <h1 className="text-[16px] font-semibold text-fg">This view failed to render</h1>
        </div>
        <p className="mt-3 text-[13.5px] text-fg-2">
          {error.message || "An unexpected error occurred while drawing this page."} Your repositories and investigations are stored by the backend and are not affected.
        </p>
        {error.digest && <p className="mt-2 font-mono text-[11.5px] text-fg-3">Reference: {error.digest}</p>}
        <div className="mt-5 flex gap-2">
          <Button variant="primary" onClick={reset}>
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </Button>
          <Link href="/"><Button>Go to the start page</Button></Link>
        </div>
      </section>
    </div>
  );
}
