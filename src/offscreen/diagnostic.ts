/**
 * Pure copy-only diagnostic builder (ADR-R11).
 *
 * Renders a stable, human-readable `key: value` block from a typed input so it
 * can be embedded in a terminal failure message and copied by the user.
 * Nothing is ever auto-sent. Takes a typed input object so it is unit-testable
 * without Chrome; the panel supplies the live values.
 *
 * Phase 1 ships the minimal field set. Phase 5 enriches it (ladder path taken,
 * chosen model, Chrome/UA version); those fields are NOT present yet.
 */

export interface DiagnosticInput {
  device: 'webgpu' | 'wasm';
  isFallback: boolean;
  /** WebGPU adapter single-allocation ceiling in bytes, or null when unknown. */
  maxBufferSize: number | null;
  /** The tier being loaded when the failure happened. Null in Phase 1 (no tier concept yet). */
  activeTier: { modelName: string; device: string; dtype: string } | null;
  /** The error's `name` (e.g. 'TypeError') or 'Error'. */
  errorClass: string;
  errorMessage: string;
  extensionVersion: string;
}

const BYTES_PER_MIB = 1024 * 1024;

function formatBufferSize(maxBufferSize: number | null): string {
  if (maxBufferSize === null) return 'n/a';
  return `${Math.round(maxBufferSize / BYTES_PER_MIB)} MiB`;
}

function formatTier(activeTier: DiagnosticInput['activeTier']): string {
  if (activeTier === null) return 'n/a';
  return `${activeTier.modelName}/${activeTier.device}/${activeTier.dtype}`;
}

/**
 * Render the minimal diagnostic as a deterministic multi-line `key: value`
 * block. No trailing whitespace; fixed field order; copy-paste friendly.
 */
export function buildDiagnostic(input: DiagnosticInput): string {
  const lines = [
    `device: ${input.device}`,
    `isFallback: ${input.isFallback}`,
    `maxBufferSize: ${formatBufferSize(input.maxBufferSize)}`,
    `activeTier: ${formatTier(input.activeTier)}`,
    `errorClass: ${input.errorClass}`,
    `errorMessage: ${input.errorMessage}`,
    `extensionVersion: ${input.extensionVersion}`,
  ];
  return lines.join('\n');
}

/**
 * Extract a uniform `{ errorClass, errorMessage }` from any caught value so
 * call sites can feed the diagnostic without per-site branching.
 */
export function errorInfo(error: unknown): { errorClass: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorClass: error.name || 'Error', errorMessage: error.message };
  }
  return { errorClass: 'Error', errorMessage: String(error) };
}
