"use client"

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { ThemeContext, type Theme } from "@/hooks/use-theme"

const STORAGE_KEY = "wanshi-theme"

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "dark" || stored === "light" || stored === "system") return stored
  } catch {
    // localStorage may throw in private browsing
  }
  return "system"
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.classList.remove("light", "dark")
  if (theme === "system") {
    root.classList.add(
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    )
  } else {
    root.classList.add(theme)
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system")

  // Hydrate from storage on mount (client-only; the inline script in the root
  // layout already applied the class to avoid a flash).
  useEffect(() => {
    setTheme(getStoredTheme())
  }, [])

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // localStorage may throw in private browsing
    }
  }, [theme])

  // Re-apply when the OS theme changes, but only while in "system" mode.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => {
      if (getStoredTheme() === "system") applyTheme("system")
    }
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  const handleSetTheme = useCallback((t: Theme) => setTheme(t), [])
  const value = useMemo(() => ({ theme, setTheme: handleSetTheme }), [theme, handleSetTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
