/**
 * Slimmed registry: only the Transformers.js backend is shipped in this extension.
 * Original registry supported firebase / gemini / openai / webllm too.
 */

export const BACKENDS = [
  {
    config: 'TRANSFORMERS_CONFIG',
    path: './backends/transformers.js',
  },
];

export async function getBackendClass(path) {
  if (path === './backends/transformers.js') {
    return (await import('./backends/transformers.js')).default;
  }
  throw new Error(`Unknown backend path "${path}"`);
}
