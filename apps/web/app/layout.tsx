import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SITE } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.agora),
  title: {
    default: SITE.name,
    template: `%s · ${SITE.name}`,
  },
  description: `${SITE.name} — ${SITE.tagline}.`,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
