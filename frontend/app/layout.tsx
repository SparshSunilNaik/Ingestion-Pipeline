import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ingestion-Pipeline · Repository Intelligence",
  description: "Evidence-grounded repository intelligence workbench",
};

// Applies the stored theme before first paint (no flash). Defaults to dark.
const THEME_SCRIPT = `try{var t=localStorage.getItem("ip.theme");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full overflow-hidden">
        <Suspense fallback={<div className="h-full bg-bg" />}>
          <AppShell>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
