/**
 * Multi-Account Manager for Antigravity Auth
 *
 * Manages multiple Google accounts with automatic rotation on rate limits.
 * Each account tracks rate limits separately per model family (claude/gemini).
 *
 * Based on opencode-antigravity-auth's accounts.ts
 */

import type { AntigravityTokens } from './types';

// ============================================================================
// Types
// ============================================================================

export type ModelFamily = 'claude' | 'gemini';
export type HeaderStyle = 'antigravity' | 'gemini-cli';
export type QuotaKey = 'claude' | 'gemini-antigravity' | 'gemini-cli';

export interface ManagedAccount {
    index: number;
    email?: string;
    projectId: string;
    refreshToken: string;
    accessToken?: string;
    expiresAt?: number;
    addedAt: number;
    lastUsed: number;
    /** Rate limit reset times per quota key */
    rateLimitResetTimes: Partial<Record<QuotaKey, number>>;
    /** Last switch reason */
    lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation';
}

export interface AccountStorageData {
    version: 1;
    accounts: Array<{
        email?: string;
        projectId: string;
        refreshToken: string;
        addedAt: number;
        lastUsed: number;
        rateLimitResetTimes?: Partial<Record<QuotaKey, number>>;
    }>;
    activeIndexByFamily: {
        claude: number;
        gemini: number;
    };
}

// ============================================================================
// Helper Functions
// ============================================================================

function nowMs(): number {
    return Date.now();
}

function getQuotaKey(family: ModelFamily, headerStyle: HeaderStyle): QuotaKey {
    if (family === 'claude') {
        return 'claude';
    }
    return headerStyle === 'gemini-cli' ? 'gemini-cli' : 'gemini-antigravity';
}

function isRateLimitedForQuotaKey(account: ManagedAccount, key: QuotaKey): boolean {
    const resetTime = account.rateLimitResetTimes[key];
    return resetTime !== undefined && nowMs() < resetTime;
}

function isRateLimitedForFamily(account: ManagedAccount, family: ModelFamily): boolean {
    if (family === 'claude') {
        return isRateLimitedForQuotaKey(account, 'claude');
    }
    // For Gemini, check both header styles
    return isRateLimitedForQuotaKey(account, 'gemini-antigravity') &&
           isRateLimitedForQuotaKey(account, 'gemini-cli');
}

function clearExpiredRateLimits(account: ManagedAccount): void {
    const now = nowMs();
    for (const key of Object.keys(account.rateLimitResetTimes) as QuotaKey[]) {
        const resetTime = account.rateLimitResetTimes[key];
        if (resetTime !== undefined && now >= resetTime) {
            delete account.rateLimitResetTimes[key];
        }
    }
}

// ============================================================================
// AccountManager Class
// ============================================================================

/**
 * Multi-account manager with automatic rotation on rate limits.
 *
 * Uses the same account until it hits a rate limit (429), then switches.
 * Rate limits are tracked per-model-family (claude/gemini) so an account
 * rate-limited for Claude can still be used for Gemini.
 */
export class AccountManager {
    private accounts: ManagedAccount[] = [];
    private cursor = 0;
    private currentAccountIndexByFamily: Record<ModelFamily, number> = {
        claude: -1,
        gemini: -1,
    };
    private logger?: { debug: (msg: string, ...args: unknown[]) => void; info: (msg: string, ...args: unknown[]) => void };

    constructor(
        logger?: { debug: (msg: string, ...args: unknown[]) => void; info: (msg: string, ...args: unknown[]) => void }
    ) {
        this.logger = logger;
    }

    /**
     * Load accounts from storage data
     */
    loadFromStorage(data: AccountStorageData | null): void {
        if (!data || data.accounts.length === 0) {
            this.accounts = [];
            this.cursor = 0;
            this.currentAccountIndexByFamily = { claude: -1, gemini: -1 };
            return;
        }

        this.accounts = data.accounts.map((acc, index): ManagedAccount => ({
            index,
            email: acc.email,
            projectId: acc.projectId,
            refreshToken: acc.refreshToken,
            addedAt: acc.addedAt,
            lastUsed: acc.lastUsed,
            rateLimitResetTimes: acc.rateLimitResetTimes || {},
        }));

        this.currentAccountIndexByFamily.claude = Math.max(0, data.activeIndexByFamily?.claude ?? 0) % Math.max(1, this.accounts.length);
        this.currentAccountIndexByFamily.gemini = Math.max(0, data.activeIndexByFamily?.gemini ?? 0) % Math.max(1, this.accounts.length);
        this.cursor = this.currentAccountIndexByFamily.claude;
    }

    /**
     * Convert to storage data for persistence
     */
    toStorageData(): AccountStorageData {
        return {
            version: 1,
            accounts: this.accounts.map(acc => ({
                email: acc.email,
                projectId: acc.projectId,
                refreshToken: acc.refreshToken,
                addedAt: acc.addedAt,
                lastUsed: acc.lastUsed,
                rateLimitResetTimes: Object.keys(acc.rateLimitResetTimes).length > 0
                    ? acc.rateLimitResetTimes
                    : undefined,
            })),
            activeIndexByFamily: {
                claude: Math.max(0, this.currentAccountIndexByFamily.claude),
                gemini: Math.max(0, this.currentAccountIndexByFamily.gemini),
            },
        };
    }

    /**
     * Add a new account from OAuth tokens
     */
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
            rateLimitResetTimes: {},
        };

        this.accounts.push(account);

        // If this is the first account, set it as active
        if (this.accounts.length === 1) {
            this.currentAccountIndexByFamily.claude = 0;
            this.currentAccountIndexByFamily.gemini = 0;
        }

        this.logger?.info(`Added new account: ${tokens.email || 'unknown'} (total: ${this.accounts.length})`);
        return account;
    }

    /**
     * Remove an account
     */
    removeAccount(index: number): boolean {
        if (index < 0 || index >= this.accounts.length) {
            return false;
        }

        this.accounts.splice(index, 1);

        // Re-index remaining accounts
        this.accounts.forEach((acc, i) => {
            acc.index = i;
        });

        // Adjust active indices
        if (this.accounts.length === 0) {
            this.cursor = 0;
            this.currentAccountIndexByFamily = { claude: -1, gemini: -1 };
        } else {
            for (const family of ['claude', 'gemini'] as ModelFamily[]) {
                if (this.currentAccountIndexByFamily[family] >= index) {
                    this.currentAccountIndexByFamily[family] = Math.max(0, this.currentAccountIndexByFamily[family] - 1);
                }
                this.currentAccountIndexByFamily[family] = Math.min(
                    this.currentAccountIndexByFamily[family],
                    this.accounts.length - 1
                );
            }
            this.cursor = Math.min(this.cursor, this.accounts.length - 1);
        }

        return true;
    }

    /**
     * Get account count
     */
    getAccountCount(): number {
        return this.accounts.length;
    }

    /**
     * Get all accounts
     */
    getAccounts(): ManagedAccount[] {
        return [...this.accounts];
    }

    /**
     * Get current account for a model family
     */
    getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
        const index = this.currentAccountIndexByFamily[family];
        if (index >= 0 && index < this.accounts.length) {
            return this.accounts[index] ?? null;
        }
        return null;
    }

    /**
     * Get current or next available account for a model family.
     * Automatically rotates to next account if current is rate limited.
     */
    getCurrentOrNextForFamily(family: ModelFamily): ManagedAccount | null {
        const current = this.getCurrentAccountForFamily(family);

        if (current) {
            clearExpiredRateLimits(current);
            if (!isRateLimitedForFamily(current, family)) {
                current.lastUsed = nowMs();
                return current;
            }
        }

        // Current is rate limited, find next available
        const next = this.getNextForFamily(family);
        if (next) {
            this.currentAccountIndexByFamily[family] = next.index;
            next.lastSwitchReason = 'rate-limit';
            this.logger?.info(`Switched to account ${next.index} (${next.email || 'unknown'}) for ${family} due to rate limit`);
        }
        return next;
    }

    /**
     * Get next available account for a model family
     */
    getNextForFamily(family: ModelFamily): ManagedAccount | null {
        const available = this.accounts.filter(a => {
            clearExpiredRateLimits(a);
            return !isRateLimitedForFamily(a, family);
        });

        if (available.length === 0) {
            return null;
        }

        const account = available[this.cursor % available.length];
        if (!account) {
            return null;
        }

        this.cursor++;
        account.lastUsed = nowMs();
        return account;
    }

    /**
     * Get available header style for an account
     * Gemini has two quota pools (antigravity vs gemini-cli)
     */
    getAvailableHeaderStyle(account: ManagedAccount, family: ModelFamily): HeaderStyle | null {
        clearExpiredRateLimits(account);

        if (family === 'claude') {
            return isRateLimitedForQuotaKey(account, 'claude') ? null : 'antigravity';
        }

        // For Gemini, try antigravity first, then gemini-cli
        if (!isRateLimitedForQuotaKey(account, 'gemini-antigravity')) {
            return 'antigravity';
        }
        if (!isRateLimitedForQuotaKey(account, 'gemini-cli')) {
            return 'gemini-cli';
        }
        return null;
    }

    /**
     * Mark an account as rate limited
     */
    markRateLimited(
        account: ManagedAccount,
        retryAfterMs: number,
        family: ModelFamily,
        headerStyle: HeaderStyle = 'antigravity'
    ): void {
        const key = getQuotaKey(family, headerStyle);
        account.rateLimitResetTimes[key] = nowMs() + retryAfterMs;
        this.logger?.info(`Account ${account.index} (${account.email || 'unknown'}) rate limited for ${key}, retry after ${retryAfterMs}ms`);
    }

    /**
     * Update account tokens after refresh
     */
    updateAccountTokens(account: ManagedAccount, accessToken: string, expiresAt: number): void {
        account.accessToken = accessToken;
        account.expiresAt = expiresAt;
    }

    /**
     * Check if all accounts are rate limited for a family
     */
    allAccountsRateLimited(family: ModelFamily): boolean {
        return this.accounts.every(a => {
            clearExpiredRateLimits(a);
            return isRateLimitedForFamily(a, family);
        });
    }

    /**
     * Get minimum wait time until an account becomes available
     */
    getMinWaitTime(family: ModelFamily): number {
        const waitTimes: number[] = [];
        const now = nowMs();

        for (const account of this.accounts) {
            if (family === 'claude') {
                const resetTime = account.rateLimitResetTimes.claude;
                if (resetTime !== undefined) {
                    waitTimes.push(Math.max(0, resetTime - now));
                }
            } else {
                // For Gemini, account becomes available when EITHER pool expires
                const t1 = account.rateLimitResetTimes['gemini-antigravity'];
                const t2 = account.rateLimitResetTimes['gemini-cli'];
                const accountWait = Math.min(
                    t1 !== undefined ? Math.max(0, t1 - now) : Infinity,
                    t2 !== undefined ? Math.max(0, t2 - now) : Infinity
                );
                if (accountWait !== Infinity) {
                    waitTimes.push(accountWait);
                }
            }
        }

        return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
    }
}
