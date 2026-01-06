/**
 * Token Store for Antigravity Auth
 *
 * Manages storage and retrieval of OAuth tokens using the plugin's secret storage.
 * Handles automatic token refresh when tokens are about to expire.
 */

import type { AntigravityTokens } from './types';
import { refreshTokens, isTokenExpired } from './auth';

// Storage keys
const STORAGE_KEY = 'antigravity_tokens';
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
    private cachedTokens: AntigravityTokens | null = null;
    private refreshPromise: Promise<AntigravityTokens> | null = null;

    constructor(secrets: SecretStorage, logger: Logger) {
        this.secrets = secrets;
        this.logger = logger;
    }

    /**
     * Initialize the token store by loading cached tokens
     */
    async initialize(): Promise<void> {
        try {
            const stored = await this.secrets.get(STORAGE_KEY);
            if (stored) {
                this.cachedTokens = JSON.parse(stored);
                this.logger.info('Loaded cached Antigravity tokens');
            }
        } catch (error) {
            this.logger.warn('Failed to load cached tokens:', error);
            this.cachedTokens = null;
        }
    }

    /**
     * Check if we have valid tokens
     */
    hasValidToken(): boolean {
        if (!this.cachedTokens) {
            return false;
        }
        // Consider token valid if we have a refresh token (we can refresh if access token expires)
        return !!this.cachedTokens.refresh_token;
    }

    /**
     * Get the current tokens (may be expired)
     */
    getTokens(): AntigravityTokens | null {
        return this.cachedTokens;
    }

    /**
     * Save tokens to storage
     */
    async saveTokens(tokens: AntigravityTokens): Promise<void> {
        this.cachedTokens = tokens;
        await this.secrets.set(STORAGE_KEY, JSON.stringify(tokens));
        this.logger.info('Saved Antigravity tokens');
    }

    /**
     * Clear all tokens (logout)
     */
    async clearTokens(): Promise<void> {
        this.cachedTokens = null;
        await this.secrets.delete(STORAGE_KEY);
        await this.secrets.delete(PENDING_VERIFIER_KEY);
        await this.secrets.delete(PENDING_STATE_KEY);
        this.logger.info('Cleared Antigravity tokens');
    }

    /**
     * Get a valid access token, refreshing if necessary.
     * This method handles concurrent refresh requests by returning the same promise.
     */
    async getValidAccessToken(): Promise<string> {
        if (!this.cachedTokens) {
            throw new Error('Not authenticated. Please login first.');
        }

        // Check if token is still valid (with 5 minute buffer)
        if (!isTokenExpired(this.cachedTokens.expires_at)) {
            return this.cachedTokens.access_token;
        }

        // Token is expired or about to expire, need to refresh
        this.logger.info('Access token expired, refreshing...');

        // If already refreshing, wait for that to complete
        if (this.refreshPromise) {
            const tokens = await this.refreshPromise;
            return tokens.access_token;
        }

        // Start refresh
        this.refreshPromise = this.doRefresh();

        try {
            const tokens = await this.refreshPromise;
            return tokens.access_token;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Perform the actual token refresh
     */
    private async doRefresh(): Promise<AntigravityTokens> {
        if (!this.cachedTokens?.refresh_token) {
            throw new Error('No refresh token available. Please login again.');
        }

        try {
            const newTokens = await refreshTokens(
                this.cachedTokens.refresh_token,
                this.cachedTokens.project_id
            );
            await this.saveTokens(newTokens);
            this.logger.info('Successfully refreshed Antigravity tokens');
            return newTokens;
        } catch (error) {
            this.logger.error('Failed to refresh tokens:', error);
            // Clear tokens on refresh failure - user needs to re-authenticate
            await this.clearTokens();
            throw new Error('Token refresh failed. Please login again.');
        }
    }

    /**
     * Get the project ID
     */
    getProjectId(): string | null {
        return this.cachedTokens?.project_id ?? null;
    }

    /**
     * Get the user email
     */
    getEmail(): string | null {
        return this.cachedTokens?.email ?? null;
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
