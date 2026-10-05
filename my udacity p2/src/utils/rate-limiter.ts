/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds (sliding window)
 * - Limits concurrent requests to prevent overwhelming the API
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;
  /** Maximum tokens per minute */
  maxTokensPerMinute: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,      // Conservative default
  maxTokensPerMinute: 100000,    // ~100k tokens/min
  maxConcurrent: 5               // Max parallel requests
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Token bucket rate limiter with sliding window
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
  }

  /**
   * Wait until a request can be made within rate limits
   *
   * This is the main entry point for rate limiting.
   * It ensures:
   * 1. Concurrent request limit is not exceeded
   * 2. Request and token rate limits are respected
   * 3. The request is recorded for future rate limit calculations
   *
   * @param estimatedTokens - Estimated tokens for this request
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
  // First wait until a concurrent request slot becomes available.
  await this.waitForSlot();

  // Then wait until the request and token rate limits
  // allow this request to proceed.
  await this.waitForRateLimit(estimatedTokens);

  // Reserve a concurrent request slot for this request.
  this.activeRequests += 1;

  // Record this request so that it is included in future
  // sliding-window rate-limit calculations.
  this.requestHistory.push({
    timestamp: Date.now(),
    tokens: estimatedTokens
  });
}

  /**
   * Release a request slot after completion
   * @param actualTokens - Actual tokens used (updates estimate)
   */
  release(actualTokens?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    // Update last request with actual token count if provided
    if (actualTokens !== undefined && this.requestHistory.length > 0) {
  const lastRequest = this.requestHistory[this.requestHistory.length - 1];
  if (lastRequest) {
    lastRequest.tokens = actualTokens;
  }
}

    // Wake up next waiting request
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce((sum, r) => sum + r.tokens, 0);

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(0, this.config.maxRequestsPerMinute - requestsInWindow),
      availableTokens: Math.max(0, this.config.maxTokensPerMinute - tokensInWindow)
    };
  }

  /**
   * Check if request can proceed immediately
   *
   * @param estimatedTokens - Estimated tokens for the request
   * @returns true if the request can proceed without waiting
   */
/**
 * Check if request can proceed immediately
 *
 * @param estimatedTokens - Estimated tokens for the request
 * @returns true if the request can proceed without waiting
 */
canProceed(estimatedTokens: number = 1000): boolean {
  // Remove request records that are older than the 60-second window.
  this.pruneOldRecords();

  // Check how many requests are currently inside the sliding window.
  const requestsInWindow = this.requestHistory.length;

  // Calculate the total estimated tokens used inside the sliding window.
  const tokensInWindow = this.requestHistory.reduce(
    (sum, record) => sum + record.tokens,
    0
  );

  // Check whether another concurrent request can be started.
  const hasAvailableConcurrentSlot =
    this.activeRequests < this.config.maxConcurrent;

  // Check whether another request can be added without exceeding
  // the maximum requests-per-minute limit.
  const hasAvailableRequestCapacity =
    requestsInWindow < this.config.maxRequestsPerMinute;

  // Check whether this request's estimated tokens would remain
  // within the maximum tokens-per-minute limit.
  const hasAvailableTokenCapacity =
    tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute;

  // The request can proceed only when ALL three limits allow it.
  return (
    hasAvailableConcurrentSlot &&
    hasAvailableRequestCapacity &&
    hasAvailableTokenCapacity
  );
}

  /**
   * Wait for a concurrent request slot to become available
   *
   * This creates a Promise that resolves when release() is called
   * and there's a queued waiter.
   */
private async waitForSlot(): Promise<void> {
  // If a concurrent slot is already available, there is no reason to wait.
  if (this.activeRequests < this.config.maxConcurrent) {
    return;
  }

  // If all concurrent slots are currently occupied, wait until
  // release() wakes this request.
  await new Promise<void>((resolve) => {
    this.waitQueue.push(resolve);
  });
}

  /**
 * Wait until rate limits allow the request to proceed
 *
 * This implements the sliding window algorithm.
 * If we can't proceed immediately, we calculate how long to wait
 * until the oldest request expires (falls out of the 60-second window).
 *
 * @param estimatedTokens - Estimated tokens for the request
 */
private async waitForRateLimit(estimatedTokens: number): Promise<void> {
  // Continue checking until the request is allowed to proceed.
  while (!this.canProceed(estimatedTokens)) {
    // Remove any request records that have already fallen
    // outside the 60-second sliding window.
    this.pruneOldRecords();

    // If there are no records left, there is nothing that can
    // prevent the request from proceeding based on the sliding window.
    if (this.requestHistory.length === 0) {
      break;
    }

    // The oldest record determines when the next request can
    // potentially leave the sliding window.
    const oldestRequest = this.requestHistory[0];

    if (!oldestRequest) {
      break;
    }

    // A request remains inside the sliding window for 60 seconds.
    const expirationTime = oldestRequest.timestamp + 60000;

    // Calculate how many milliseconds remain until the oldest
    // request expires.
    const now = Date.now();
    const waitTimeUntilExpiration = expirationTime - now;

    // Add a small 100ms buffer so that the expired record has
    // definitely moved outside the window before checking again.
    const waitTimeWithBuffer = waitTimeUntilExpiration + 100;

    // Ensure we never wait for less than 100ms.
    const minimumWaitTime = 100;

    // Cap each individual wait at 5 seconds so that the limiter
    // periodically rechecks the current rate-limit state.
    const maximumWaitTime = 5000;

    const waitTime = Math.min(
      maximumWaitTime,
      Math.max(minimumWaitTime, waitTimeWithBuffer)
    );

    // Wait before checking the rate limits again.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitTime);
    });
  }
}

  /**
   * Remove request records older than 60 seconds (sliding window)
   *
   * This is called before checking rate limits to ensure we only
   * count requests in the current 60-second window.
   */
private pruneOldRecords(): void {
  const cutoffTimestamp = Date.now() - 60000;

  this.requestHistory = this.requestHistory.filter(
    (record) => record.timestamp > cutoffTimestamp
  );
}
}

/**
 * Wrap an async function with rate limiting
 *
 * This is a convenience function for applying rate limiting to any async operation.
 */
export function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      await rateLimiter.acquire(estimatedTokens);
      const result = await fn();
      rateLimiter.release();
      resolve(result);
    } catch (error) {
      rateLimiter.release();
      reject(error);
    }
  });
}

// Global rate limiter instance
export const globalRateLimiter = new RateLimiter();