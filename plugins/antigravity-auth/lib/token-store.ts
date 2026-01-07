/**
 * Token Store for Antigravity Auth
 *
 * Manages storage and retrieval of OAuth tokens using the plugin's secret storage.
 * Supports multiple accounts with automatic rotation via AccountManager.
 */

import type { AntigravityTokens } from './types';
import { refreshTokens, isTokenExpired } from './auth';
import { AccountManager, type ManagedAccount, type ModelFamily, type HeaderStyle, type AccountStorageData } from './account-manager';

// Storage keys
const ACCOUNTS_STORAGE_KEY = 'antigravity_accounts';
const PENDING_VERIFIER_KEY = 'pending_verifier';
const PENDING_STATE_KEY = 'pending_state';

// ============================================================================
// Token Store Interface
// ============================================================================

export interface SecretStorage {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Token Store Implementation
// ============================================================================

export class TokenStore {
    private secrets: SecretStorage;
    private logger: Logger;
    private accountManager: AccountManager;
    private refreshPromises: Map<number, Promise<ManagedAccount>> = new Map();

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
        this.accountManager = new AccountManager(logger);
    }

    /**
     * Initialize the token store by loading cached accounts
     */
    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(ACCOUNTS_STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored) as AccountStorageData;
                this.accountManager.loadFromStorage(data);
                this.logger.info(`Loaded ${this.accountManager.getAccountCount()} Antigravity account(s)`);
            }
        } catch (error) {
            this.logger.warn('Failed to load cached accounts:', error);
        }
    }

    /**
     * Save accounts to storage
     */
    async saveAccounts(): Promise<void> {
        const data = this.accountManager.toStorageData();
        await this.secrets.set(ACCOUNTS_STORAGE_KEY, JSON.stringify(data));
    }

    /**
     * Check if we have valid tokens (at least one account)
     */
    hasValidToken(): boolean {
        return this.accountManager.getAccountCount() > 0;
    }

    /**
     * Get account manager for direct access
     */
    getAccountManager(): AccountManager {
        return this.accountManager;
    }

    /**
     * Add a new account from OAuth tokens
     */
    async addAccount(tokens: AntigravityTokens): Promise<ManagedAccount> {
        const account = this.accountManager.addAccount(tokens);
        await this.saveAccounts();
        return account;
    }

    /**
     * Remove an account by index
     */
    async removeAccount(index: number): Promise<boolean> {
        const result = this.accountManager.removeAccount(index);
        if (result) {
            await this.saveAccounts();
        }
        return result;
    }

    /**
     * Save tokens (for backward compatibility - adds as new account)
     */
    async saveTokens(tokens: AntigravityTokens): Promise<void> {
        await this.addAccount(tokens);
    }

    /**
     * Clear all accounts (logout all)
     */
    async clearTokens(): Promise<void> {
        // Remove all accounts
        while (this.accountManager.getAccountCount() > 0) {
            this.accountManager.removeAccount(0);
        }
        await this.secrets.delete(ACCOUNTS_STORAGE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
        await this.secrets.delete(PENDING_STATE_KEY);
        this.logger.info('Cleared all Antigravity accounts');
    }

    /**
     * Get valid access token for a model family.
     * Automatically rotates to next account if current is rate limited.
     */
    async getValidAccessTokenForFamily(family: ModelFamily): Promise<{ accessToken: string; projectId: string; account: ManagedAccount; headerStyle: HeaderStyle }> {
        const account = this.accountManager.getCurrentOrNextForFamily(family);

        if (!account) {
            if (this.accountManager.getAccountCount() === 0) {
                throw new Error('Not authenticated. Please login first.');
            }
            // All accounts are rate limited
            const waitTime = this.accountManager.getMinWaitTime(family);
            throw new Error(`All accounts are rate limited. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
        }

        // Determine header style (for Gemini, try both quota pools)
        const headerStyle = this.accountManager.getAvailableHeaderStyle(account, family) || 'antigravity';

        // Check if token needs refresh
        if (!account.accessToken || !account.expiresAt || isTokenExpired(account.expiresAt)) {
            await this.refreshAccountToken(account);
        }

        return {
            accessToken: account.accessToken!,
            projectId: account.projectId,
            account,
            headerStyle,
        };
    }

    /**
     * Get a valid access token (backward compatibility - uses claude family)
     */
    async getValidAccessToken(): Promise<string> {
        const result = await this.getValidAccessTokenForFamily('claude');
        return result.accessToken;
    }

    /**
     * Refresh token for a specific account
     */
    private async refreshAccountToken(account: ManagedAccount): Promise<void> {
        // If already refreshing this account, wait for that to complete
        const existingPromise = this.refreshPromises.get(account.index);
        if (existingPromise) {
            await existingPromise;
            return;
        }

        const refreshPromise = this.doRefreshAccount(account);
        this.refreshPromises.set(account.index, refreshPromise);

        try {
            await refreshPromise;
        } finally {
            this.refreshPromises.delete(account.index);
        }
    }

    /**
     * Perform the actual token refresh for an account
     */
    private async doRefreshAccount(account: ManagedAccount): Promise<ManagedAccount> {
        this.logger.info(`Refreshing token for account ${account.index} (${account.email || 'unknown'})...`);

        try {
            const newTokens = await refreshTokens(account.refreshToken, account.projectId);

            // Update account with new tokens
            this.accountManager.updateAccountTokens(
                account,
                newTokens.access_token,
                newTokens.expires_at
            );

            // Update refresh token if it changed
            if (newTokens.refresh_token !== account.refreshToken) {
                account.refreshToken = newTokens.refresh_token;
            }

            await this.saveAccounts();
            this.logger.info(`Successfully refreshed token for account ${account.index}`);
            return account;
        } catch (error) {
            this.logger.error(`Failed to refresh token for account ${account.index}:`, error);
            // Don't remove account on refresh failure - might be temporary
            throw new Error(`Token refresh failed for account ${account.email || account.index}. Please re-authenticate.`);
        }
    }

    /**
     * Mark an account as rate limited
     */
    async markRateLimited(
        account: ManagedAccount,
        retryAfterMs: number,
        family: ModelFamily,
        headerStyle: HeaderStyle = 'antigravity'
    ): Promise<void> {
        this.accountManager.markRateLimited(account, retryAfterMs, family, headerStyle);
        await this.saveAccounts();
    }

    /**
     * Get the project ID (from first account for backward compatibility)
     */
    getProjectId(): string | null {
        const accounts = this.accountManager.getAccounts();
        return accounts[0]?.projectId ?? null;
    }

    /**
     * Get the user email (from first account for backward compatibility)
     */
    getEmail(): string | null {
        const accounts = this.accountManager.getAccounts();
        return accounts[0]?.email ?? null;
    }

    /**
     * Get account count
     */
    getAccountCount(): number {
        return this.accountManager.getAccountCount();
    }

    /**
     * Get all accounts info for display
     */
    getAccountsInfo(): Array<{ index: number; email?: string; projectId: string }> {
        return this.accountManager.getAccounts().map(a => ({
            index: a.index,
            email: a.email,
            projectId: a.projectId,
        }));
    }

    // =========================================================================
    // Pending OAuth State Management
    // =========================================================================

    /**
     * Store pending OAuth verifier for code exchange
     */
    async storePendingVerifier(verifier: string): Promise<void> {
        await this.secrets.set(PENDING_VERIFIER_KEY, verifier);
    }

    /**
     * Get and clear pending OAuth verifier
     */
    async getPendingVerifier(): Promise<string | null> {
        const verifier = await this.secrets.get(PENDING_VERIFIER_KEY);
        if (verifier) {
            await this.secrets.delete(PENDING_VERIFIER_KEY);
        }
        return verifier ?? null;
    }

    /**
     * Store pending OAuth state for validation
     */
    async storePendingState(state: string): Promise<void> {
        await this.secrets.set(PENDING_STATE_KEY, state);
    }

    /**
     * Get pending OAuth state
     */
    async getPendingState(): Promise<string | null> {
        const state = await this.secrets.get(PENDING_STATE_KEY);
        return state ?? null;
    }

    /**
     * Clear pending OAuth state
     */
    async clearPendingState(): Promise<void> {
        await this.secrets.delete(PENDING_STATE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
    }
}
