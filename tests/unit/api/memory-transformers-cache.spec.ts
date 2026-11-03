import { afterEach, expect, it, vi } from "vitest";

const { pipeline } = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline }));
vi.mock("@omniroute/open-sse/utils/error.ts", () => ({
  sanitizeErrorMessage: (value: string) => value,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  pipeline.mockReset();
});

it("downloads models into the data volume and bounds inference threads", async () => {
  vi.stubEnv("DATA_DIR", "/persistent/data");
  vi.stubEnv("MEMORY_TRANSFORMERS_CACHE_DIR", "");
  vi.stubEnv("MEMORY_TRANSFORMERS_MODEL", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
  pipeline.mockResolvedValue(async () => ({ dims: [1, 1, 2], data: new Float32Array([1, 0]) }));
  const { embedTransformers } = await import("../../../src/lib/memory/embedding/transformersLocal");
  expect(await embedTransformers("Preferências em português")).toMatchObject({
    source: "transformers",
    dimensions: 2,
  });
  await embedTransformers("A segunda consulta reutiliza o modelo");
  expect(pipeline).toHaveBeenCalledTimes(1);
  expect(pipeline).toHaveBeenCalledWith(
    "feature-extraction",
    "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    {
      dtype: "q8",
      cache_dir: "/persistent/data/embeddings/transformers",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    }
  );
});

it("honors an explicit persistent model cache directory", async () => {
  vi.stubEnv("MEMORY_TRANSFORMERS_CACHE_DIR", "/persistent/models");
  pipeline.mockResolvedValue(async () => ({ dims: [1, 1, 2], data: new Float32Array([1, 0]) }));
  const { embedTransformers } = await import("../../../src/lib/memory/embedding/transformersLocal");
  await embedTransformers("Memória por usuário");
  expect(pipeline.mock.calls[0][2].cache_dir).toBe("/persistent/models");
});
