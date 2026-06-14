"use client"

import { useQuery } from "@tanstack/react-query"
import { apiGet } from "@/lib/api"
import type { SchemaPayload } from "@/lib/config-schema"

/**
 * Fetch the wanshi config schema from the backend (`/api/config-schema`, which
 * shells out to `wanshi schema`). The form renders from this — no duplicated
 * option list. The schema only changes on a backend rebuild, so cache it hard.
 */
export function useConfigSchema() {
  return useQuery({
    queryKey: ["config-schema"],
    queryFn: () => apiGet<SchemaPayload>("/api/config-schema"),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  })
}
