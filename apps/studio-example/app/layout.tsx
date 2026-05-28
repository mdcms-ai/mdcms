import type { ReactNode } from "react";

import "./site.css";

export const metadata = {
  title: "MDCMS Demo",
  description: "Rendered example site backed by MDCMS content documents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
