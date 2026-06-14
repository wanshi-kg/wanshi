import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "./providers"
import { AppShell } from "@/components/layout/app-shell"

export const metadata: Metadata = {
  title: "Wan Shi",
  description: "Configure, run, and watch knowledge-graph generation.",
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
    <html lang="en" suppressHydrationWarning>
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
