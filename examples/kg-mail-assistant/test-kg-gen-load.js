#!/usr/bin/env node

console.log("Testing kg-gen dynamic require...\n");

try {
  console.log("1. Attempting to load ContainerFactory...");
  const ContainerFactory = require("kg-gen/src/core/di/ContainerFactory").ContainerFactory;
  console.log("   ✅ ContainerFactory loaded:", typeof ContainerFactory);

  console.log("\n2. Attempting to load TYPES...");
  const TYPES = require("kg-gen/src/core/di/index").TYPES;
  console.log("   ✅ TYPES loaded:", typeof TYPES);
  console.log("   ✅ TYPES.FileProcessor:", TYPES.FileProcessor);

  console.log("\n3. Creating container...");
  const container = ContainerFactory.createContainer({
    processingOptions: {
      input: "./data/emails",
      filter: ["**/*.txt", "**/*.md"],
      classifier: "heuristic",
    },
  });
  console.log("   ✅ Container created:", typeof container);

  console.log("\n4. Resolving FileProcessor...");
  container.resolve(TYPES.FileProcessor).then((fileProcessor) => {
    console.log("   ✅ FileProcessor resolved:", typeof fileProcessor);
    console.log("\n✅ All kg-gen dependencies loaded successfully!");
  });
} catch (error) {
  console.error("\n❌ Error loading kg-gen:");
  console.error(error);
  process.exit(1);
}
