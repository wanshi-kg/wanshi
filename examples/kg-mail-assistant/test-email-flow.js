#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

// Simple test of email processing
async function testEmailProcessing() {
  console.log("Testing email processing flow...\n");

  // 1. Load kg-gen
  console.log("1. Loading kg-gen...");
  const ContainerFactory = require("kg-gen/src/core/di/ContainerFaParsed emailctory")
    .ContainerFactory;
  const TYPES = require("kg-gen/src/core/di/index").TYPES;

  // 2. Create container
  console.log("2. Creating kg-gen container...");
  const container = ContainerFactory.createContainer({
    processingOptions: {
      input: "./data/emails",
      filter: ["**/*.txt", "**/*.md"],
      classifier: "heuristic",
    },
  });

  // 3. Resolve FileProcessor
  console.log("3. Resolving FileProcessor...");
  const fileProcessor = await container.resolve(TYPES.FileProcessor);
  console.log("   ✅ FileProcessor ready\n");

  // 4. Create a test email
  const testEmails = [
    {
      from: "linkedin-jobs@linkedin.com",
      subject: "New Software Engineer Position",
      text: "Dear John,\n\nWe found a new job opportunity for you: Senior Software Engineer at TechCorp.",
      date: new Date(),
      messageId: "test-1",
    },
    {
      from: "medium-digest@medium.com",
      subject: "Your Weekly Digest: Top AI Articles",
      text: "This week we selected the top articles about Artificial Intelligence for you.",
      date: new Date(),
      messageId: "test-2",
    },
    {
      from: "shop@amazon.com",
      subject: "Your order has been shipped",
      text: "Order #123 has been shipped. Track it here: ...",
      date: new Date(),
      messageId: "test-3",
    },
  ];

  // 5. Process each email
  for (const email of testEmails) {
    console.log(`4. Processing email from ${email.from}:`);
    console.log(`   Subject: ${email.subject}`);

    const emailContent = `Subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date.toISOString()}\nMessage-ID: ${email.messageId || "N/A"}\n---\n${email.text}`;

    const emailPath = path.join("./data/emails", `test-${email.messageId}.txt`);
    fs.writeFileSync(emailPath, emailContent);

    try {
      const result = await fileProcessor.processFile(emailPath);
      console.log(`   ✅ Classes: ${JSON.stringify(result.metadata?.classes || [])}`);
    } catch (error) {
      console.error(`   ❌ Error: ${error}`);
    }

    fs.unlinkSync(emailPath);
  }

  console.log(
    "\n✅ Email processing test complete!"
  );
}

testEmailProcessing().catch(console.error);
