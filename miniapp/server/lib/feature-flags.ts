/**
 * Feature flags for v2 result rollout.
 *
 * All flags read from env at call time (not cached) so they can be
 * toggled without restart via process.env mutation in tests.
 */

export interface FeatureFlags {
  /** Enable v2 result contract (summary, artifacts). Default: true */
  resultV2Enabled: boolean
  /** Enable artifact indexing into FTS5 on task fetch. Default: true */
  artifactIndexingEnabled: boolean
  /** Enable /search endpoint. Default: true */
  searchEndpointEnabled: boolean
  /** Max bytes of legacy stdout to keep inline when v2 is disabled. Default: 64KB */
  legacyStdoutCapBytes: number
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key]
  if (val === undefined) return fallback
  return val.toLowerCase() === 'true'
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key]
  if (val === undefined) return fallback
  const n = parseInt(val, 10)
  return Number.isFinite(n) ? n : fallback
}

export function getFeatureFlags(): FeatureFlags {
  return {
    resultV2Enabled: envBool('RESULT_V2_ENABLED', true),
    artifactIndexingEnabled: envBool('ARTIFACT_INDEXING_ENABLED', true),
    searchEndpointEnabled: envBool('SEARCH_ENDPOINT_ENABLED', true),
    legacyStdoutCapBytes: envInt('LEGACY_STDOUT_CAP_BYTES', 64 * 1024),
  }
}
