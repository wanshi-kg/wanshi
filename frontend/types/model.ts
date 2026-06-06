/** A model offered by a provider, as listed by the /api/models proxy. */
export interface ModelOption {
  id: string
  label: string
  size?: string
}

export interface ModelsResponse {
  models: ModelOption[]
  error?: string
}
