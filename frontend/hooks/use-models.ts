"use client"

import { useQuery } from "@tanstack/react-query"
import { apiPost } from "@/lib/api"
import type { ModelsResponse } from "@/types"

/**
 * List models for a provider/host (proxied via /api/models). Keyed by
 * provider+host so it's cached and doesn't refetch per render; gate `enabled`
 * (e.g. on the picker being open) so typing the host doesn't spam requests.
 */
export function useModels(
  provider: string,
  host: string,
  apiKey: string | undefined,
  enabled: boolean
) {
  return useQuery({
    queryKey: ["models", provider, host],
    queryFn: () =>
      apiPost<ModelsResponse>("/api/models", { provider, host, apiKey }),
    enabled: enabled && !!host,
    staleTime: 30_000,
    retry: false,
  })
}
