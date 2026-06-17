/**
 * Pure copy-only diagnostic builder (ADR-R11).
 *
 * Renders a stable, human-readable `key: value` block from a typed input so it
 * can be embedded in a terminal failure message and copied by the user.
 * Nothing is ever auto-sent. Takes a typed input object so it is unit-testable
 * without Chrome; the panel supplies the live values.
 *
 * Phase 1 shipped the minimal field set. Phase 5 enriches it with the chosen
 * model, the full ladder path taken (per-tier outcomes), the raw user agent,
 * and a best-effort parsed Chrome version.
 */

/** A single tier the ladder attempted, with the outcome the panel observed. */
export interface LadderPathEntry {
  modelName: string;
  device: string;
  dtype: string;
  outcome: 'success' | 'load-failure' | 'network';
}

export interface DiagnosticInput {
  device: 'webgpu' | 'wasm';
  isFallback: boolean;
  /** WebGPU adapter single-allocation ceiling in bytes, or null when unknown. */
  maxBufferSize: number | null;
  /** Approximate system RAM in GiB (navigator.deviceMemory), or null/undefined when unknown. */
  deviceMemory?: number | null;
  /** The model the ladder selected (chosen up front). Null when no walk has run. */
  chosenModel: string | null;
  /** The tier being loaded when the failure happened. Null when no tier was attempted. */
  activeTier: { modelName: string; device: string; dtype: string } | null;
  /** The ordered tiers tried this walk with their outcomes. Empty when no walk ran. */
  ladderPath: LadderPathEntry[];
  /** The error's `name` (e.g. 'TypeError') or 'Error'. */
  errorClass: string;
  errorMessage: string;
  extensionVersion: string;
  /** The raw `navigator.userAgent`, included verbatim (UA parsing is brittle). */
  userAgent: string;
}

const BYTES_PER_MIB = 1024 * 1024;

function formatBufferSize(maxBufferSize: number | null): string {
  if (maxBufferSize === null) return 'n/a';
  return `${Math.round(maxBufferSize / BYTES_PER_MIB)} MiB`;
}

function formatDeviceMemory(deviceMemory: number | null | undefined): string {
  if (deviceMemory == null) return 'n/a';
  return `${deviceMemory} GB`;
}

function formatTier(activeTier: DiagnosticInput['activeTier']): string {
  if (activeTier === null) return 'n/a';
  return `${activeTier.modelName}/${activeTier.device}/${activeTier.dtype}`;
}

/**
 * Best-effort Chrome version from a user-agent string. Matches `Chrome/<ver>`;
 * returns null on a non-Chrome UA. Chromium-based browsers (Edge, Brave) carry
 * the `Chrome/` token too, so this reflects the underlying Chromium version,
 * which is the relevant fact for a WebGPU/polyfill report. Pure, exported and
 * tested. Parsing the precise brand reliably is brittle, so the raw UA is
 * included verbatim in the report alongside this.
 */
export function parseChromeVersion(ua: string): string | null {
  const match = ua.match(/Chrome\/([\d.]+)/);
  return match ? match[1] : null;
}

/**
 * Render the full ladder path as one tier per line (`model/device/dtype ->
 * outcome`). An empty path renders the single token `none`.
 */
function formatLadderPath(path: LadderPathEntry[]): string {
  if (path.length === 0) return 'none';
  return path.map((e) => `${e.modelName}/${e.device}/${e.dtype} -> ${e.outcome}`).join('\n');
}

/**
 * Render the diagnostic as a deterministic multi-line block. No trailing
 * whitespace; fixed field order; copy-paste friendly. The ladder path is a
 * readable sub-list under its own label.
 */
export function buildDiagnostic(input: DiagnosticInput): string {
  const chromeVersion = parseChromeVersion(input.userAgent) ?? 'n/a';
  const lines = [
    `device: ${input.device}`,
    `isFallback: ${input.isFallback}`,
    `maxBufferSize: ${formatBufferSize(input.maxBufferSize)}`,
    `deviceMemory: ${formatDeviceMemory(input.deviceMemory)}`,
    `chosenModel: ${input.chosenModel ?? 'n/a'}`,
    `activeTier: ${formatTier(input.activeTier)}`,
    'ladderPath:',
    formatLadderPath(input.ladderPath),
    `errorClass: ${input.errorClass}`,
    `errorMessage: ${input.errorMessage}`,
    `extensionVersion: ${input.extensionVersion}`,
    `chromeVersion: ${chromeVersion}`,
    `userAgent: ${input.userAgent}`,
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
