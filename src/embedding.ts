/**
 * Local embedding surface for Mixedbread / ONNX Runtime.
 * The release ships an embedder bundle entry for a stable distribution layout.
 */

export interface Embedder {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export async function createEmbedder(): Promise<Embedder> {
  throw new Error("createEmbedder is not implemented");
}

export function mixedbreadDocumentText(title: string, heading: string, body: string): string {
  return [title, heading, body].filter(Boolean).join("\n\n");
}
