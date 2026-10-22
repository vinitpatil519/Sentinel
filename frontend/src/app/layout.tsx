import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import Shell from "@/components/Shell";

/**
 * Three faces, each with one job. IBM Plex Mono carries every reading: its
 * digits share the sans metrics, so a readout that switches between the two
 * does not shift. Barlow Condensed carries labels, titles and the advisory
 * word — a condensed face keeps dense uppercase labels short and legible at
 * arm's length. Plex Sans is the running text. Weights are limited to those
 * actually used, since every extra weight is a font file on a machine that may
 * be tethered in the field.
 */
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const barlow = Barlow_Condensed({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SENTINEL // RF Through-Wall Sensing Console",
  description:
    "RF human sensing console: subject detection, respiration and behavioural state estimation, and approach advisory, from WiFi channel state information.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#050708",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${barlow.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
