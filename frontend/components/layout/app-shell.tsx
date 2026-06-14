"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ThemeToggle } from "@/components/theme-toggle"
import { ErrorBoundary } from "@/components/error-boundary"
import {
  LayoutDashboard,
  Play,
  Share2,
  Network,
  Settings2,
} from "lucide-react"

const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/run", icon: Play, label: "Run" },
  { to: "/results", icon: Share2, label: "Results" },
  { to: "/graph", icon: Network, label: "Graph" },
  { to: "/settings", icon: Settings2, label: "Settings" },
]

function isActivePath(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/"
  return pathname === to || pathname.startsWith(`${to}/`)
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="hidden w-56 flex-col border-r bg-sidebar md:flex">
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Network className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Wan Shi</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 p-2">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => {
            const active = isActivePath(pathname, to)
            return (
              <Link
                key={to}
                href={to}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="border-t p-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">local</span>
          <ThemeToggle />
        </div>
      </aside>

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex h-14 items-center gap-4 border-b px-4 md:hidden">
          <Network className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm flex-1">Wan Shi</span>
          <ThemeToggle />
        </header>

        {/* Mobile nav */}
        <nav className="flex gap-1 overflow-x-auto border-b px-2 py-1 md:hidden">
          {NAV_ITEMS.map(({ to, label }) => {
            const active = isActivePath(pathname, to)
            return (
              <Link
                key={to}
                href={to}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-4 md:p-6">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
