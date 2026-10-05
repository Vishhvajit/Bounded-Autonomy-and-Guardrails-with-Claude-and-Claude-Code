import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewReport } from "./types/report-types.js";
import {
  ReviewReportSchema,
  ReviewReportJSONSchema,
} from "./types/report-types.js";
import { mcpServersConfig } from "./config/mcp.config.js";
import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester,
} from "./agents/index.js";
import { buildOrchestratorPrompt } from "./prompts/orchestrator.prompt.js";

export interface OrchestratorOptions {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export class CodeReviewOrchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewReport> {
    if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("Invalid pull request information.");
    }

    const prompt = buildOrchestratorPrompt(owner, repo, prNumber);

    const queryResult = query({
      prompt,
      options: {
        model:
          this.options.model ||
          process.env.ANTHROPIC_MODEL ||
          "claude-sonnet-4-5-20250929",

        cwd: this.options.cwd || process.cwd(),

        mcpServers: mcpServersConfig,

        agents: {
          codeQualityAnalyzer,
          testCoverageAnalyzer,
          refactoringSuggester,
        },

        allowedTools: [
          "Task",
          "mcp__github__get_pull_request",
          "mcp__github__get_pull_request_files",
          "Skill",
        ],

        outputFormat: {
          type: "json_schema",
          schema: ReviewReportJSONSchema,
        },
      },
    });

    let finalReport: ReviewReport | undefined;

    for await (const message of queryResult) {
      if (
        message.type === "result" &&
        message.subtype === "success" &&
        message.structured_output
      ) {
        const parsed = ReviewReportSchema.safeParse(message.structured_output);

        if (!parsed.success) {
          throw new Error(
            `Invalid structured review report: ${parsed.error.message}`,
          );
        }

        finalReport = parsed.data;
      }

      if (message.type === "result" && message.subtype !== "success") {
        throw new Error(`Code review failed: ${message.subtype}`);
      }
    }

    if (!finalReport) {
      throw new Error(
        "Code review completed without a valid structured report.",
      );
    }

    return ReviewReportSchema.parse({
      ...finalReport,
      metadata: {
        ...finalReport.metadata,
        analyzedAt: new Date().toISOString(),
      },
    });
  }
}
