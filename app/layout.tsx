import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OHAUS Support Assistants",
  description: "Internal tolerance, workbook-grounded product sales, and compatibility tools in one workspace.",
  openGraph: {
    title: "OHAUS Support Assistants",
    description: "Tolerance lookup, workbook-grounded product answers, and an interactive compatibility web.",
    images: [{ url: "/og.png", width: 1730, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "OHAUS Support Assistants",
    description: "Tolerance lookup, workbook-grounded product answers, and an interactive compatibility web.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
