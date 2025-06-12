import { appendFileSync } from "fs";
import { Logger as TSLogger } from "tslog";

export const logger = new TSLogger<any>({
  name: "kg-gen",
});

export const llmLogger = new TSLogger<any>({
  name: "ollama",
  attachedTransports: [
    (logObj) => {
      appendFileSync("./ollama_messages.log.jsonl", JSON.stringify(logObj) + "\n");
    },
  ],
});
