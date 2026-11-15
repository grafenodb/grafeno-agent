import { homedir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "./types.js";

interface ModelSpec {
  /** Its id on Hugging Face. */
  readonly id: string;
  readonly dimension: number;
  /** Whether it expects "query: " and "passage: " in front of each text. */
  readonly prefixes: boolean;
}

export type LocalModelName = "e5-small";

/** The local models the agent knows, by the name `AGENT_EMBEDDER` gives. */
export const LOCAL_MODELS: Readonly<Record<LocalModelName, ModelSpec>> = {
  /** Multilingual (Spanish and English among them), 384 numbers a vector, ~130 MB quantized. */
  "e5-small": { id: "Xenova/multilingual-e5-small", dimension: 384, prefixes: true },
};

export interface LocalEmbedderOptions {
  /** Where downloaded models are kept. Default: `~/.cache/grafeno-agent/models`. */
  readonly cacheDir?: string;
}

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * The optional package, loaded by a name the compiler does not follow: the
 * agent builds and runs without it (memory then works by words alone), so
 * its types are not needed to build either.
 */
export const TRANSFORMERS: string = "@huggingface/transformers";

/** What the agent uses of transformers.js. */
interface Transformers {
  readonly env: { cacheDir: string };
  pipeline(task: string, model: string, options: { dtype: string }): Promise<Extractor>;
}

/** transformers.js, when it is installed; throws when it is not. */
export async function loadTransformers(): Promise<Transformers> {
  return (await import(TRANSFORMERS)) as Transformers;
}

/**
 * Embeddings computed on this computer with transformers.js (ONNX), no
 * service and no API: the model is downloaded from Hugging Face once, on
 * first use, then read from the cache.
 */
export function localEmbedder(model: LocalModelName, options: LocalEmbedderOptions = {}): Embedder {
  const spec = LOCAL_MODELS[model];
  let extractor: Promise<Extractor> | undefined;

  async function load(): Promise<Extractor> {
    const transformers = await loadTransformers();
    transformers.env.cacheDir =
      options.cacheDir ?? join(homedir(), ".cache", "grafeno-agent", "models");
    const pipe = await transformers.pipeline("feature-extraction", spec.id, { dtype: "q8" });
    return pipe;
  }

  return {
    name: model,
    dimension: spec.dimension,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      extractor ??= load();
      const run = await extractor;
      // e5 models were trained with these prefixes on what is asked and what is stored.
      const input = spec.prefixes ? texts.map((t) => `${kind}: ${t}`) : [...texts];
      const output = await run(input, { pooling: "mean", normalize: true });
      return output.tolist();
    },
  };
}
