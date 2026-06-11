#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

async function testKgGenProcessing() {
  try {
    console.log("Loading kg-gen...");
    const ContainerFactory = require("kg-gen/src/core/di/ContainerFactory")
      .ContainerFactory;
    const TYPES = require("kg-gen/src/core/di/index").TYPES;

    console.log("Creating container...");
    const processingOptions = {
      input: "./data/emails",
      filter: ["**/*.txt", "**/*.md"],
      classifier: "heuristic",
    };

    const container = ContainerFactory.createContainer({
      processingOptions,
    });

    console.log("Resolving FileProcessor...");
    const fileProcessor = await container.resolve(TYPES.FileProcessor);

    // Create a test email file
    const testEmailContent = `Subject: Test Email
From: test@example.com
Date: 2025-11-15T00:00:00.000Z
Message-ID: test-123
---
This is a test email about job opportunities and software development.
`;

    const testEmailPath = path.join("./data/emails", "test-email.txt");
    fs.writeFileSync(testEmailPath, testEmailContent);
    console.log("Created test email:", testEmailPath);

    console.log("Processing email with kg-gen...");
    const result = await fileProcessor.processFile(testEmailPath);

    console.log("\n✅ kg-gen processing successful!");
    console.log("Result metadata:", result.metadata);

    // Clean up
    fs.unlinkSync(testEmailPath);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

testKgGenProcessing();
