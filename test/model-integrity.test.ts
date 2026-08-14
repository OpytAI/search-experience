/**
 * Model load-path contract: Transformers dtype=uint8 + subfolder=onnx must hit
 * aliases that map to the shipped verified model/model.onnx bytes.
 */
import { assert } from "./assert.ts";
import {
  TRANSFORMERS_MODEL_ID,
  TRANSFORMERS_MODEL_WEIGHT_ALIASES,
  TRANSFORMERS_SIDE_FILES,
} from "../src/embedding/mixedbread.ts";

assert(TRANSFORMERS_MODEL_ID === "model", "model id used with localModelPath package root");
assert(
  TRANSFORMERS_MODEL_WEIGHT_ALIASES.includes("model/onnx/model_uint8.onnx"),
  "alias for Transformers uint8+onnx path",
);
assert(
  TRANSFORMERS_MODEL_WEIGHT_ALIASES.includes("model/model.onnx"),
  "alias for shipped package path",
);
assert(TRANSFORMERS_SIDE_FILES.config === "model/config.json", "config path");
assert(TRANSFORMERS_SIDE_FILES.tokenizer === "model/tokenizer.json", "tokenizer path");
assert(
  TRANSFORMERS_SIDE_FILES.tokenizerConfig === "model/tokenizer_config.json",
  "tokenizer_config path",
);

// Document the resolution formula used by @huggingface/transformers@3.x models.js:
//   baseName = `${fileName}${dtypeSuffix}.onnx`  // uint8 → model_uint8.onnx
//   modelFileName = `${subfolder}/${baseName}`   // onnx/model_uint8.onnx
//   requestURL = pathJoin(modelId, modelFileName) // model/onnx/model_uint8.onnx
const dtype = "uint8";
const subfolder = "onnx";
const fileName = "model";
const suffix = dtype === "uint8" ? "_uint8" : "";
const expected = `${TRANSFORMERS_MODEL_ID}/${subfolder}/${fileName}${suffix}.onnx`;
assert(expected === "model/onnx/model_uint8.onnx", "documented transformers resolution");
assert(
  (TRANSFORMERS_MODEL_WEIGHT_ALIASES as readonly string[]).includes(expected),
  "verified alias list includes transformers resolution",
);

console.log("model-integrity.test.ts: ok");
