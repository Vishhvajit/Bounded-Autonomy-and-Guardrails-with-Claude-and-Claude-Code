import { describe, expect, it } from "vitest";

import { CodeReviewOrchestrator } from "../src/orchestrator.js";
import { ReviewReportSchema } from "../src/types/report-types.js";
import { RateLimiter, withRetry, withTimeout } from "../src/utils/index.js";

describe("CodeReviewOrchestrator", () => {
  describe("Configuration", () => {
    it("should initialize with default options", () => {
      const orchestrator = new CodeReviewOrchestrator();

      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });

    it("should accept a custom model configuration", () => {
      const orchestrator = new CodeReviewOrchestrator({
        model: "claude-sonnet-4-5-20250929",
      });

      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);
    });
  });

  describe("reviewPullRequest", () => {
    it("should reject an invalid pull request number", async () => {
      const orchestrator = new CodeReviewOrchestrator();

      await expect(
        orchestrator.reviewPullRequest("octocat", "Hello-World", 0),
      ).rejects.toThrow("Invalid pull request information.");
    });

    it("should reject missing repository information", async () => {
      const orchestrator = new CodeReviewOrchestrator();

      await expect(
        orchestrator.reviewPullRequest("", "Hello-World", 1),
      ).rejects.toThrow("Invalid pull request information.");
    });
  });

  describe("ReviewReportSchema", () => {
    it("should accept a valid ReviewReport object", () => {
      const validReport = {
        pullRequest: {
          owner: "octocat",
          repo: "Hello-World",
          number: 1,
        },
        fileReviews: [],
        summary: {
          totalFiles: 0,
          overallScore: 100,
          criticalIssues: 0,
          highPriorityTests: 0,
          refactoringOpportunities: 0,
        },
        recommendations: [],
        metadata: {
          analyzedAt: new Date().toISOString(),
          duration: 100,
          agentVersions: {},
        },
      };

      expect(() => ReviewReportSchema.parse(validReport)).not.toThrow();
    });

    it("should reject an invalid recommendation priority", () => {
      const invalidReport = {
        pullRequest: {
          owner: "octocat",
          repo: "Hello-World",
          number: 1,
        },
        fileReviews: [],
        summary: {
          totalFiles: 0,
          overallScore: 100,
          criticalIssues: 0,
          highPriorityTests: 0,
          refactoringOpportunities: 0,
        },
        recommendations: [
          {
            priority: "urgent",
            category: "security",
            description: "Invalid priority value",
            files: [],
          },
        ],
        metadata: {
          analyzedAt: new Date().toISOString(),
          duration: 100,
          agentVersions: {},
        },
      };

      expect(() => ReviewReportSchema.parse(invalidReport)).toThrow();
    });
  });

  describe("withRetry", () => {
    it("should retry a failed operation and eventually succeed", async () => {
      let attempts = 0;

      const result = await withRetry(
        async () => {
          attempts += 1;

          if (attempts < 3) {
            throw new Error("Temporary failure");
          }

          return "success";
        },
        2,
        1,
      );

      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should throw after all retries are exhausted", async () => {
      let attempts = 0;

      await expect(
        withRetry(
          async () => {
            attempts += 1;
            throw new Error("Permanent failure");
          },
          2,
          1,
        ),
      ).rejects.toThrow("Operation failed after all retry attempts");

      expect(attempts).toBe(3);
    });
  });

  describe("withTimeout", () => {
    it("should return the operation result when it finishes before timeout", async () => {
      const result = await withTimeout(async () => "completed", 100);

      expect(result).toBe("completed");
    });

    it("should reject when the operation exceeds the timeout", async () => {
      await expect(
        withTimeout(
          () =>
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("completed"), 50);
            }),
          10,
        ),
      ).rejects.toThrow("Operation timed out");
    });
  });

  describe("RateLimiter", () => {
    it("should allow a request when capacity is available", async () => {
      const rateLimiter = new RateLimiter({
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 10000,
        maxConcurrent: 2,
      });

      await rateLimiter.acquire(1000);

      expect(rateLimiter.getStatus().activeRequests).toBe(1);

      rateLimiter.release();
    });

    it("should limit concurrent requests", async () => {
      const rateLimiter = new RateLimiter({
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 10000,
        maxConcurrent: 1,
      });

      await rateLimiter.acquire(1000);

      let secondRequestAcquired = false;

      const secondRequest = rateLimiter.acquire(1000).then(() => {
        secondRequestAcquired = true;
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });

      expect(secondRequestAcquired).toBe(false);

      rateLimiter.release();

      await secondRequest;

      expect(secondRequestAcquired).toBe(true);

      rateLimiter.release();
    });
  });

  describe("Integration", () => {
    it.skip("should review a real small PR", async () => {
      // Requires valid API credentials and an accessible public repository.
    });
  });
});
