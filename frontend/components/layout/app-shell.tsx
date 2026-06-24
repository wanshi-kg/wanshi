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
  Activity,
  ClipboardCheck,
  History,
  Settings2,
  type LucideIcon,
} from "lucide-react"

interface NavItem {
  to: string
  icon: LucideIcon
  label: string
  /** Parked surface — links to a ComingSoon stub, tagged in the nav. */
  soon?: boolean
}

/**
 * One app, modes (the brief). The shared explorer + inspector underlie Explore
 * and Debug; Review is a parked stub. Chrome is deliberately plain —
 * Sable's "tactical instrument" aesthetic converges here later.
 */
const NAV_GROUPS: { mode: string; items: NavItem[] }[] = [
  {
    mode: "Explore",
    items: [
      { to: "/", icon: LayoutDashboard, label: "Dashboard" },
      { to: "/graph", icon: Network, label: "Graph" },
      { to: "/results", icon: Share2, label: "Results" },
      { to: "/timeline", icon: History, label: "Timeline" },
    ],
  },
  {
    mode: "Debug",
    items: [{ to: "/trace", icon: Activity, label: "Trace" }],
  },
  {
    mode: "Review",
    items: [{ to: "/review", icon: ClipboardCheck, label: "Curate", soon: true }],
  },
  {
    mode: "Run",
    items: [{ to: "/run", icon: Play, label: "New run" }],
  },
]

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items)

function isActivePath(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/"
  return pathname === to || pathname.startsWith(`${to}/`)
}

function SoonTag() {
  return (
    <span className="ml-auto rounded bg-muted px-1 text-[10px] font-medium uppercase text-muted-foreground">
      soon
    </span>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="hidden w-56 flex-col border-r bg-sidebar md:flex">
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b px-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wanshi-avatar-256.svg" alt="" className="h-6 w-6" />
          <span className="font-display text-sm font-semibold tracking-tight">wanshi</span>
        </div>

        {/* Navigation — grouped by mode */}
        <nav className="flex-1 space-y-4 overflow-y-auto p-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.mode} className="space-y-1">
              <div className="px-3 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {group.mode}
              </div>
              {group.items.map(({ to, icon: Icon, label, soon }) => {
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
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                    {soon && <SoonTag />}
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="flex items-center justify-between border-t p-3">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="h-3.5 w-3.5" /> Settings
          </Link>
          <ThemeToggle />
        </div>
      </aside>

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex h-14 items-center gap-4 border-b px-4 md:hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wanshi-avatar-256.svg" alt="" className="h-6 w-6" />
          <span className="flex-1 text-sm font-semibold">wanshi</span>
          <ThemeToggle />
        </header>

        {/* Mobile nav (flattened) */}
        <nav className="flex gap-1 overflow-x-auto border-b px-2 py-1 md:hidden">
          {ALL_ITEMS.map(({ to, label }) => {
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
