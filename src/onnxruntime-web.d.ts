declare module "@huggingface/transformers" {
  export const env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    useCustomCache: boolean;
    customCache: unknown;
    backends: {
      onnx?: {
        wasm?: {
          wasmPaths?: string | Record<string, string>;
          numThreads?: number;
          proxy?: boolean;
        };
      };
    };
  };
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<{
    (inputs: string[], options?: Record<string, unknown>): Promise<{ tolist: () => unknown }>;
    dispose?: () => Promise<void>;
  }>;
}
