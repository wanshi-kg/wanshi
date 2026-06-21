import type { Metadata } from "next"
import { Space_Grotesk, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google"
import "./globals.css"
import { Providers } from "./providers"
import { AppShell } from "@/components/layout/app-shell"

// Sable's trio: Space Grotesk (display) · IBM Plex Sans (body) · JetBrains Mono
// (mono — load-bearing for IDs/locators/lineage). Self-hosted by next/font.
const fontDisplay = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
})
const fontSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ibm",
  display: "swap",
})
const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
})

export const metadata: Metadata = {
  title: "wanshi",
  description: "Configure, run, and watch knowledge-graph generation.",
  icons: { icon: "/wanshi-avatar-256.svg" },
}

// Applied before paint to avoid a light/dark flash on first load. Mirrors the
// storage key + system fallback used by ThemeProvider.
const noFlashScript = `
(function () {
  try {
    var t = localStorage.getItem("wanshi-theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.add(dark ? "dark" : "light");
  } catch (e) {}
})();
`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
