export type FeatureName =
  | "messages"
  | "auth"
  | "cors-allowlist"
  | "repos"
  | "sessions-create"
  | "diff-viewer"
  | "screenshots-http"
  | "pr-preview"
  | "parallel-variants"
  | "web-push"

export interface FeatureStore {
  features: string[]
}

export function hasFeature(store: FeatureStore, name: FeatureName): boolean {
  return store.features.includes(name)
}
