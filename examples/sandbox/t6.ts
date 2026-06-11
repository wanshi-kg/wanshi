import {
  AutoModelForCausalLM,
  AutoTokenizer,
  AutoModelForTokenClassification,
  pipeline,
} from "@huggingface/transformers";
import { promises } from "fs";
import path from "path";

async function main() {
//   const model = await AutoModelForTokenClassification.from_pretrained(
//     "dslim/bert-base-NER",
//     {
//         dtype: "auto",
//         device: "gpu",
//     }
//   );

  const pipe = await pipeline("text-generation", "Qwen/Qwen3-0.6B", { device: "cpu" });
//   const data = await promises.readFile("/Users/oleksii/Downloads/33/docs/doc.md", "utf-8");
  const res = await pipe("Hello! How are you today?");
  console.log(res);
}

main();
