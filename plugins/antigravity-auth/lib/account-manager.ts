/**
 * Multi-Account Manager for Antigravity Auth
 *
 * Manages multiple Google accounts with automatic rotation on rate limits.
 * This implementation matches Antigravity-Manager's token_manager.rs exactly.
 */

import type { AntigravityTokens } from './types';
import type { QuotaData } from './quota';

// ============================================================================
// Types
// ============================================================================

export type ModelFamily = 'claude' | 'gemini';
export type HeaderStyle = 'antigravity' | 'gemini-cli';
export type RequestType = 'claude' | 'gemini' | 'image_gen';

// Rate limit reason types (matching Antigravity-Manager)
export type RateLimitReason = 'quota_exhausted' | 'rate_limit_exceeded' | 'server_error' | 'unknown';

// Subscription tier (matching Antigravity-Manager)
export type SubscriptionTier = 'ULTRA' | 'PRO' | 'FREE' | 'UNKNOWN';

// Scheduling mode (matching Antigravity-Manager's sticky_config.rs)
export type SchedulingMode = 'CacheFirst' | 'Balance' | 'PerformanceFirst';

// Sticky session config (matching Antigravity-Manager)
export interface StickySessionConfig {
    /** Current scheduling mode */
    mode: SchedulingMode;
    /** Max wait time in seconds for CacheFirst mode */
    maxWaitSeconds: number;
}

export const DEFAULT_STICKY_CONFIG: StickySessionConfig = {
    mode: 'Balance',
    maxWaitSeconds: 60,
};

// Default cooldown times in ms (matching Antigravity-Manager)
export const RATE_LIMIT_DEFAULTS = {
    quota_exhausted: 60 * 60 * 1000,     // 1 hour for quota exhaustion
    rate_limit_exceeded: 30 * 1000,       // 30 seconds for rate limiting
    server_error: 20 * 1000,              // 20 seconds for server errors
    unknown: 60 * 1000,                   // 60 seconds for unknown errors
} as const;

// 60s global lock duration (matching Antigravity-Manager)
export const GLOBAL_LOCK_DURATION_MS = 60 * 1000;

// Rate limit info (matching Antigravity-Manager's RateLimitInfo)
export interface RateLimitInfo {
    resetTime: number;      // timestamp in ms
    retryAfterMs: number;
    detectedAt: number;
    reason: RateLimitReason;
}

export interface ManagedAccount {
    index: number;
    email?: string;
    projectId: string;
    refreshToken: string;
    accessToken?: string;
    expiresAt?: number;
    addedAt: number;
    lastUsed: number;
    /** Subscription tier (ULTRA > PRO > FREE) for priority sorting */
    subscriptionTier?: SubscriptionTier;
    /** Real quota data from API */
    quota?: QuotaData;
    /** Whether account is disabled (e.g., due to invalid_grant) */
    disabled?: boolean;
    /** Reason for disabling */
    disabledReason?: string;
}

export interface AccountStorageData {
    version: 1;
    accounts: Array<{
        email?: string;
        projectId: string;
        refreshToken: string;
        addedAt: number;
        lastUsed: number;
        subscriptionTier?: SubscriptionTier;
        quota?: QuotaData;
        disabled?: boolean;
        disabledReason?: string;
    }>;
    currentIndex: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

function nowMs(): number {
    return Date.now();
}

/**
 * Get subscription tier priority (lower = higher priority)
 * Matches Antigravity-Manager: ULTRA > PRO > FREE
 */
function getTierPriority(tier: SubscriptionTier | undefined): number {
    switch (tier) {
        case 'ULTRA': return 0;
        case 'PRO': return 1;
        case 'FREE': return 2;
        default: return 3;
    }
}

/**
 * Parse rate limit reason from error response body
 * Matches Antigravity-Manager's parse_rate_limit_reason logic
 */
export function parseRateLimitReason(errorBody: string): RateLimitReason {
    try {
        const json = JSON.parse(errorBody);
        const details = json?.error?.details;
        if (Array.isArray(details) && details.length > 0) {
            const reason = details[0]?.reason;
            if (reason === 'QUOTA_EXHAUSTED') {
                return 'quota_exhausted';
            }
            if (reason === 'RATE_LIMIT_EXCEEDED') {
                return 'rate_limit_exceeded';
            }
        }
    } catch {
        // JSON parse failed, try text matching
    }

    // Fallback to text matching
    const lowerBody = errorBody.toLowerCase();
    if (lowerBody.includes('exhausted') || lowerBody.includes('quota')) {
        return 'quota_exhausted';
    }
    if (lowerBody.includes('rate limit') || lowerBody.includes('too many requests')) {
        return 'rate_limit_exceeded';
    }

    return 'unknown';
}

/**
 * Parse duration string like "2h1m30s", "42s", "500ms"
 * Matches Antigravity-Manager's parse_duration_string
 */
function parseDurationString(s: string): number | undefined {
    const regex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/;
    const match = s.match(regex);
    if (!match) return undefined;

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseFloat(match[3] || '0');
    const milliseconds = parseInt(match[4] || '0', 10);

    const totalMs = (hours * 3600 + minutes * 60 + Math.ceil(seconds)) * 1000 + milliseconds;
    return totalMs > 0 ? totalMs : undefined;
}

/**
 * Parse retry delay from error response (matches Antigravity-Manager)
 */
export function parseRetryDelay(errorBody: string): number | undefined {
    try {
        const json = JSON.parse(errorBody);
        const details = json?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                // Check quotaResetDelay in metadata
                const quotaDelay = detail?.metadata?.quotaResetDelay;
                if (typeof quotaDelay === 'string') {
                    const parsed = parseDurationString(quotaDelay);
                    if (parsed !== undefined) return parsed;
                }

                // Check retryDelay in RetryInfo
                if (detail?.['@type']?.includes('RetryInfo')) {
                    const retryDelay = detail?.retryDelay;
                    if (typeof retryDelay === 'string') {
                        const parsed = parseDurationString(retryDelay);
                        if (parsed !== undefined) return parsed;
                    }
                }
            }
        }

        // OpenAI style retry_after
        const retryAfter = json?.error?.retry_after;
        if (typeof retryAfter === 'number') {
            return retryAfter * 1000;
        }
    } catch {
        // JSON parse failed
    }

    // Regex fallback patterns (matching Antigravity-Manager)
    const patterns = [
        /try again in (\d+)m\s*(\d+)s/i,
        /(?:try again in|backoff for|wait)\s*(\d+)s/i,
        /quota will reset in (\d+) second/i,
        /retry after (\d+) second/i,
        /\(wait (\d+)s\)/,
    ];

    for (const pattern of patterns) {
        const match = errorBody.match(pattern);
        if (match) {
            if (match[2]) {
                // Minutes and seconds format
                return (parseInt(match[1], 10) * 60 + parseInt(match[2], 10)) * 1000;
            }
            return parseInt(match[1], 10) * 1000;
        }
    }

    return undefined;
}

// ============================================================================
// AccountManager Class (matching Antigravity-Manager's TokenManager)
// ============================================================================

export class AccountManager {
    private accounts: ManagedAccount[] = [];
    /** Atomic round-robin index (matching Antigravity-Manager's current_index) */
    private currentIndex = 0;
    private logger?: { debug: (msg: string, ...args: unknown[]) => void; info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void };

    /** Rate limit tracker per account_id (matching Antigravity-Manager) */
    private rateLimits: Map<string, RateLimitInfo> = new Map();

    /** Session fingerprint -> account index binding (for conversation stickiness) */
    private sessionBindings: Map<string, number> = new Map();

    /** Last used account info for 60s global lock (non-image requests) */
    private lastUsedAccount: { accountIndex: number; timestamp: number } | null = null;

    /** Scheduling mode config (matching Antigravity-Manager's sticky_config) */
    private stickyConfig: StickySessionConfig = { ...DEFAULT_STICKY_CONFIG };

    constructor(
        logger?: { debug: (msg: string, ...args: unknown[]) => void; info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void }
    ) {
        this.logger = logger;
    }

    // =========================================================================
    // Scheduling Config
    // =========================================================================

    getStickyConfig(): StickySessionConfig {
        return { ...this.stickyConfig };
    }

    setStickyConfig(config: Partial<StickySessionConfig>): void {
        this.stickyConfig = { ...this.stickyConfig, ...config };
        this.logger?.info(`Scheduling mode set to: ${this.stickyConfig.mode}`);
    }

    getSchedulingMode(): SchedulingMode {
        return this.stickyConfig.mode;
    }

    setSchedulingMode(mode: SchedulingMode): void {
        this.stickyConfig.mode = mode;
        this.logger?.info(`Scheduling mode set to: ${mode}`);
    }

    // =========================================================================
    // Storage Operations
    // =========================================================================

    loadFromStorage(data: AccountStorageData | null): void {
        if (!data || data.accounts.length === 0) {
            this.accounts = [];
            this.currentIndex = 0;
            return;
        }

        this.accounts = data.accounts
            .filter(acc => !acc.disabled) // Skip disabled accounts
            .map((acc, index): ManagedAccount => ({
                index,
                email: acc.email,
                projectId: acc.projectId,
                refreshToken: acc.refreshToken,
                addedAt: acc.addedAt,
                lastUsed: acc.lastUsed,
                subscriptionTier: acc.subscriptionTier,
                quota: acc.quota,
                disabled: acc.disabled,
                disabledReason: acc.disabledReason,
            }));

        this.currentIndex = data.currentIndex ?? 0;
        this.logger?.info(`Loaded ${this.accounts.length} Antigravity account(s)`);
    }

    toStorageData(): AccountStorageData {
        return {
            version: 1,
            accounts: this.accounts.map(acc => ({
                email: acc.email,
                projectId: acc.projectId,
                refreshToken: acc.refreshToken,
                addedAt: acc.addedAt,
                lastUsed: acc.lastUsed,
                subscriptionTier: acc.subscriptionTier,
                quota: acc.quota,
                disabled: acc.disabled,
                disabledReason: acc.disabledReason,
            })),
            currentIndex: this.currentIndex,
        };
    }

    // =========================================================================
    // Account Management
    // =========================================================================

    addAccount(tokens: AntigravityTokens): ManagedAccount {
        // Check if account already exists (by email or refresh token)
        const existing = this.accounts.find(a =>
            (tokens.email && a.email === tokens.email) ||
            a.refreshToken === tokens.refresh_token
        );

        if (existing) {
            // Update existing account
            existing.refreshToken = tokens.refresh_token;
            existing.projectId = tokens.project_id;
            existing.accessToken = tokens.access_token;
            existing.expiresAt = tokens.expires_at;
            existing.email = tokens.email;
            existing.disabled = false;
            existing.disabledReason = undefined;
            this.logger?.info(`Updated existing account: ${tokens.email || 'unknown'}`);
            return existing;
        }

        // Add new account
        const account: ManagedAccount = {
            index: this.accounts.length,
            email: tokens.email,
            projectId: tokens.project_id,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            expiresAt: tokens.expires_at,
            addedAt: nowMs(),
            lastUsed: 0,
        };

        this.accounts.push(account);
        this.logger?.info(`Added new account: ${tokens.email || 'unknown'} (total: ${this.accounts.length})`);
        return account;
    }

    removeAccount(index: number): boolean {
        if (index < 0 || index >= this.accounts.length) {
            return false;
        }

        const removed = this.accounts.splice(index, 1)[0];

        // Re-index remaining accounts
        this.accounts.forEach((acc, i) => {
            acc.index = i;
        });

        // Clear rate limit for removed account
        if (removed) {
            this.rateLimits.delete(removed.email || String(removed.index));
        }

        // Adjust currentIndex
        if (this.accounts.length === 0) {
            this.currentIndex = 0;
        } else {
            this.currentIndex = this.currentIndex % this.accounts.length;
        }

        return true;
    }

    /**
     * Disable account (e.g., due to invalid_grant)
     * Matches Antigravity-Manager's disable_account
     */
    disableAccount(account: ManagedAccount, reason: string): void {
        account.disabled = true;
        account.disabledReason = reason;
        this.logger?.warn(`Disabled account ${account.email || account.index}: ${reason}`);
    }

    getAccountCount(): number {
        return this.accounts.filter(a => !a.disabled).length;
    }

    getAccounts(): ManagedAccount[] {
        return [...this.accounts];
    }

    getAccountByIndex(index: number): ManagedAccount | null {
        return this.accounts[index] ?? null;
    }

    // =========================================================================
    // Rate Limit Tracking (matching Antigravity-Manager per account_id)
    // =========================================================================

    /**
     * Check if account is rate limited
     * Matches Antigravity-Manager's is_rate_limited
     */
    isRateLimited(accountId: string): boolean {
        const info = this.rateLimits.get(accountId);
        if (!info) return false;
        return info.resetTime > nowMs();
    }

    /**
     * Get remaining wait time in seconds
     * Matches Antigravity-Manager's get_remaining_wait
     */
    getRemainingWait(accountId: string): number {
        const info = this.rateLimits.get(accountId);
        if (!info) return 0;
        const remaining = info.resetTime - nowMs();
        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    /**
     * Get reset time in seconds for an account
     * Matches Antigravity-Manager's get_reset_seconds
     */
    getResetSeconds(accountId: string): number | undefined {
        const info = this.rateLimits.get(accountId);
        if (!info) return undefined;
        const remaining = info.resetTime - nowMs();
        return remaining > 0 ? Math.ceil(remaining / 1000) : undefined;
    }

    /**
     * Mark account as rate limited
     * Matches Antigravity-Manager's parse_from_error
     */
    markRateLimited(
        accountId: string,
        status: number,
        retryAfterHeader: string | undefined,
        errorBody: string
    ): RateLimitInfo | undefined {
        // Only handle 429, 500, 503, 529
        if (status !== 429 && status !== 500 && status !== 503 && status !== 529) {
            return undefined;
        }

        // 1. Parse reason
        const reason: RateLimitReason = status === 429
            ? parseRateLimitReason(errorBody)
            : 'server_error';

        // 2. Parse retry delay
        let retryAfterMs: number | undefined;

        // From header
        if (retryAfterHeader) {
            const seconds = parseInt(retryAfterHeader, 10);
            if (!isNaN(seconds)) {
                retryAfterMs = seconds * 1000;
            }
        }

        // From body
        if (retryAfterMs === undefined) {
            retryAfterMs = parseRetryDelay(errorBody);
        }

        // Apply defaults based on reason (with 2s minimum safety buffer)
        if (retryAfterMs !== undefined && retryAfterMs < 2000) {
            retryAfterMs = 2000;
        }

        if (retryAfterMs === undefined) {
            retryAfterMs = RATE_LIMIT_DEFAULTS[reason];
        }

        const info: RateLimitInfo = {
            resetTime: nowMs() + retryAfterMs,
            retryAfterMs,
            detectedAt: nowMs(),
            reason,
        };

        this.rateLimits.set(accountId, info);
        this.logger?.warn(
            `Account ${accountId} [${status}] rate limited: ${reason}, retry after ${retryAfterMs / 1000}s`
        );

        return info;
    }

    /**
     * Clear rate limit for an account
     */
    clearRateLimit(accountId: string): boolean {
        return this.rateLimits.delete(accountId);
    }

    /**
     * Clear all rate limits (乐观重置策略)
     *
     * 用于乐观重置机制，当所有账号都被限流但等待时间很短时，
     * 清除所有限流记录以解决时序竞争条件
     */
    clearAllRateLimits(): void {
        const count = this.rateLimits.size;
        this.rateLimits.clear();
        this.logger?.warn(`Optimistic reset: Cleared all ${count} rate limit record(s)`);
    }

    // =========================================================================
    // Session Stickiness (matching Antigravity-Manager)
    // =========================================================================

    getAccountForSession(sessionId: string): ManagedAccount | null {
        const index = this.sessionBindings.get(sessionId);
        if (index !== undefined && index < this.accounts.length) {
            const account = this.accounts[index];
            if (account && !account.disabled) {
                return account;
            }
        }
        return null;
    }

    bindSession(sessionId: string, accountIndex: number): void {
        this.sessionBindings.set(sessionId, accountIndex);
        this.logger?.debug(`Bound session ${sessionId.slice(0, 8)}... to account ${accountIndex}`);
    }

    unbindSession(sessionId: string): void {
        this.sessionBindings.delete(sessionId);
    }

    clearSessionBindings(): void {
        this.sessionBindings.clear();
    }

    // =========================================================================
    // 60s Global Lock (matching Antigravity-Manager)
    // =========================================================================

    getLastUsedAccount(): { accountIndex: number; timestamp: number } | null {
        return this.lastUsedAccount;
    }

    updateLastUsedAccount(accountIndex: number): void {
        this.lastUsedAccount = { accountIndex, timestamp: nowMs() };
    }

    clearLastUsedAccount(): void {
        this.lastUsedAccount = null;
    }

    // =========================================================================
    // Core Account Selection (matching Antigravity-Manager's get_token_internal)
    // =========================================================================

    /**
     * Get sorted accounts snapshot by tier priority
     * Matches Antigravity-Manager's tier sorting
     */
    getSortedAccountsSnapshot(): ManagedAccount[] {
        const snapshot = this.accounts.filter(a => !a.disabled);
        snapshot.sort((a, b) =>
            getTierPriority(a.subscriptionTier) - getTierPriority(b.subscriptionTier)
        );
        return snapshot;
    }

    /**
     * Select next account using round-robin within sorted accounts
     * Matches Antigravity-Manager's current_index.fetch_add logic
     *
     * @param sortedAccounts - Tier-sorted accounts snapshot
     * @param attempted - Set of already attempted account IDs
     * @param skipRateLimited - Whether to skip rate-limited accounts
     * @returns Selected account or null
     */
    selectNextAccount(
        sortedAccounts: ManagedAccount[],
        attempted: Set<string>,
        skipRateLimited: boolean = true
    ): ManagedAccount | null {
        const total = sortedAccounts.length;
        if (total === 0) return null;

        const startIdx = this.currentIndex % total;
        this.currentIndex = (this.currentIndex + 1) % total;

        for (let offset = 0; offset < total; offset++) {
            const idx = (startIdx + offset) % total;
            const candidate = sortedAccounts[idx];
            const accountId = candidate.email || String(candidate.index);

            if (attempted.has(accountId)) {
                continue;
            }

            if (skipRateLimited && this.isRateLimited(accountId)) {
                continue;
            }

            return candidate;
        }

        return null;
    }

    /**
     * Get minimum wait time across all rate-limited accounts
     * Matches Antigravity-Manager's min_wait calculation
     * Returns undefined if no accounts are rate-limited
     */
    getMinWaitTime(): number | undefined {
        let minWait: number | undefined = undefined;

        for (const account of this.accounts) {
            if (account.disabled) continue;
            const accountId = account.email || String(account.index);
            const seconds = this.getResetSeconds(accountId);
            if (seconds !== undefined) {
                if (minWait === undefined || seconds < minWait) {
                    minWait = seconds;
                }
            }
        }

        return minWait;
    }

    /**
     * Update account tokens after refresh
     */
    updateAccountTokens(account: ManagedAccount, accessToken: string, expiresAt: number): void {
        account.accessToken = accessToken;
        account.expiresAt = expiresAt;
    }
}
