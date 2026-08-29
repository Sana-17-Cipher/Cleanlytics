import type { Metadata } from "next";
import "./globals.css";
import AuthShell from "../components/AuthShell";

export const metadata: Metadata = {
  title: "CLEANYTICS | Multi-Table Data Analytics Workspace",
  description: "Enterprise-grade data cleaning, multi-table profiling, relationship discovery, and interactive BI dashboards.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">
        <AuthShell>{children}</AuthShell>
      </body>
    </html>
  );
}
