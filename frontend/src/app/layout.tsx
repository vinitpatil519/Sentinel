import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import Shell from "@/components/Shell";

/**
 * IBM Plex: drawn for technical interfaces, with a mono cut whose digits share
 * the sans metrics. That matters here — a readout that switches between the two
 * must not shift. Weights are limited to the four actually used, since every
 * extra weight is a font file on a machine that may be tethered in the field.
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

export const metadata: Metadata = {
  title: "SENTINEL — Through-Wall Human Sensing Console",
  description:
    "RF human sensing console: subject detection, respiration and behavioural state estimation, and approach advisory, from WiFi channel state information.",
};

export const viewport: Viewport = {
  themeColor: "#0a0c0f",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
