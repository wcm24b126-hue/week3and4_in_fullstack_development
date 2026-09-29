export interface ModelInfo {
  id: string;
  label: string;
  hint: string;
}

/**
 * Curated defaults. Any id can be typed into `nightrider.model` to use a model
 * that is not listed here, so this is a convenience list and not a whitelist.
 *
 * Only chat/code models are listed. Audio (whisper), TTS (orpheus) and
 * moderation (prompt-guard, gpt-oss-safeguard) models are omitted. Groq retires
 * model ids on a few months' notice, so check
 * https://console.groq.com/docs/models when one here starts returning
 * "model does not exist".
 */
export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", hint: "Balanced - best default" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", hint: "Fast, good for edits" },
  { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B", hint: "Multilingual, 131K ctx (preview)" },
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "Enterprise plan only" },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "Enterprise plan only" },
  { id: "minimaxai/minimax-m2.7", label: "MiniMax M2.7", hint: "Agentic, 196K ctx (enterprise preview)" }
];

export function modelLabel(id: string): string {
  const found = MODELS.find((m) => m.id === id);
  return found ? found.label : id;
}
