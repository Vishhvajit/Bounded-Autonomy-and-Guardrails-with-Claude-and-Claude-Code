import * as dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CodeReviewOrchestrator } from "./orchestrator.js";
import { ReportGenerator } from "./utils/report-generator.js";
import {
  logReviewStart,
  logReviewComplete,
  logReviewError,
} from "./utils/logger.js";
// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 *
 * Usage:
 * npm run dev -- <owner> <repo> <pr-number>
 */
async function main(): Promise<void> {
  const [owner, repo, prStr] = process.argv.slice(2);

  // 1. Validate command-line arguments
  if (!owner || !repo || !prStr) {
    throw new Error("Usage: npm run dev -- <owner> <repo> <pr-number>");
  }

  const prNumber = Number(prStr);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `Invalid pull request number: "${prStr}". It must be a positive integer.`,
    );
  }

  // 2. Validate authentication
  const hasAnthropicAuth = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasAwsAuth =
    Boolean(process.env.AWS_ACCESS_KEY_ID) &&
    Boolean(process.env.AWS_SECRET_ACCESS_KEY);

  if (!hasAnthropicAuth && !hasAwsAuth) {
    throw new Error(
      "No authentication configured. Set ANTHROPIC_API_KEY for Anthropic API, " +
        "or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS Bedrock.",
    );
  }

  if (hasAnthropicAuth) {
    console.log("🔐 Using Anthropic API authentication");
  } else {
    if (!process.env.AWS_REGION) {
      throw new Error(
        "AWS_REGION is required when using AWS Bedrock authentication.",
      );
    }

    console.log("🔐 Using AWS Bedrock authentication");
  }

  // 3. Validate model
  const model = process.env.ANTHROPIC_MODEL;

  if (!model) {
    throw new Error(
      "ANTHROPIC_MODEL is not configured. Set it in the environment or .env file.",
    );
  }

  console.log(`🤖 Model: ${model}`);
  console.log(`🔍 Reviewing ${owner}/${repo} PR #${prNumber}`);

  try {
    // 4. Create the orchestrator
    const orchestrator = new CodeReviewOrchestrator({
      model,
    });

    // 5. Run the code review
    const reviewStart = Date.now();

    logReviewStart(owner, repo, prNumber);

    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    // Ensure the duration reflects the actual review execution.
    report.metadata.duration = Date.now() - reviewStart;
    logReviewComplete(
      owner,
      repo,
      prNumber,
      report.summary.overallScore,
      report.metadata.duration,
    );
    // 6. Generate reports
    const reportGenerator = new ReportGenerator();

    const jsonReport = reportGenerator.generateJSONReport(report);
    const markdownReport = reportGenerator.generateMarkdownReport(report);
    const htmlReport = reportGenerator.generateHTMLReport(report);

    // 7. Create reports directory
    const reportsDirectory = path.resolve(process.cwd(), "reports");

    await mkdir(reportsDirectory, { recursive: true });

    // 8. Create required filenames
    const baseName = `${owner}_${repo}_${prNumber}`;

    const jsonPath = path.join(reportsDirectory, `${baseName}.json`);

    const markdownPath = path.join(reportsDirectory, `${baseName}.md`);

    const htmlPath = path.join(reportsDirectory, `${baseName}.html`);

    // 9. Save all three report formats
    await Promise.all([
      writeFile(jsonPath, jsonReport, "utf-8"),
      writeFile(markdownPath, markdownReport, "utf-8"),
      writeFile(htmlPath, htmlReport, "utf-8"),
    ]);

    console.log("\n✅ Code review completed successfully.");
    console.log(`📊 Overall score: ${report.summary.overallScore}/100`);
    console.log(`📁 Files reviewed: ${report.summary.totalFiles}`);
    console.log(`🚨 Critical issues: ${report.summary.criticalIssues}`);
    console.log(`🧪 High-priority tests: ${report.summary.highPriorityTests}`);
    console.log(
      `🔧 Refactoring opportunities: ${report.summary.refactoringOpportunities}`,
    );

    console.log("\n📄 Reports generated:");
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Markdown: ${markdownPath}`);
    console.log(`  HTML: ${htmlPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logReviewError(
      owner,
      repo,
      prNumber,
      error instanceof Error ? error : new Error(String(error)),
    );

    console.error("\n❌ Code review failed.");
    console.error(`Error: ${message}`);

    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`❌ ${message}`);
  process.exitCode = 1;
});
