/**
 * Antigravity Auth Plugin for Alma
 *
 * Enables using Google Antigravity subscription to access Claude and Gemini models
 * via OAuth authentication. This plugin registers a custom provider that handles
 * authentication and API calls to the Antigravity backend.
 *
 * Supports multiple accounts with automatic rotation on rate limits.
 *
 * Based on opencode-antigravity-auth and follows openai-codex-auth patterns.
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Antigravity subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { getAuthorizationUrl, exchangeCodeForTokens } from './lib/auth';
import { ANTIGRAVITY_MODELS, getModelFamily, isClaudeThinkingModel, isImageModel, parseImageAspectRatio } from './lib/models';
import type { ManagedAccount, ModelFamily, HeaderStyle, RequestType } from './lib/account-manager';
import { parseRateLimitReason, parseRetryDelay } from './lib/account-manager';
import {
    isGenerativeLanguageRequest,
    transformRequest,
    transformStreamingResponse,
    transformNonStreamingResponse,
    ANTIGRAVITY_ENDPOINTS,
} from './lib/request-transform';

// ============================================================================
// Constants
// ============================================================================

const ANTIGRAVITY_BASE_URL = 'https://generativelanguage.googleapis.com';
const DUMMY_API_KEY = 'antigravity-oauth';

// HTTP status codes
const HTTP_STATUS = {
    TOO_MANY_REQUESTS: 429,
    SERVER_ERROR: 500,
} as const;

// Default retry-after time in ms (5 minutes)
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1000;

// ============================================================================
// Session Fingerprint Extraction
// ============================================================================

/**
 * Extract or generate a session fingerprint from the request body.
 * This is used for session stickiness - same conversation should use same account.
 *
 * Matching Antigravity-Manager's session fingerprinting logic:
 * - Uses contents hash for conversation context continuity
 * - Falls back to generating from first message if no existing context
 */
function extractSessionFingerprint(body: string): string | undefined {
    try {
        const parsed = JSON.parse(body);

        // Check for explicit session ID
        if (parsed.sessionId && typeof parsed.sessionId === 'string') {
            return parsed.sessionId;
        }

        // Generate fingerprint from contents (conversation history)
        // This ensures the same conversation thread uses the same account
        if (Array.isArray(parsed.contents) && parsed.contents.length > 0) {
            // Use first few messages to create a stable fingerprint
            const fingerprint = parsed.contents
                .slice(0, 3)
                .map((c: { role?: string; parts?: Array<{ text?: string }> }) => {
                    const role = c.role || '';
                    const text = c.parts?.[0]?.text?.slice(0, 50) || '';
                    return `${role}:${text}`;
                })
                .join('|');

            // Simple hash function
            let hash = 0;
            for (let i = 0; i < fingerprint.length; i++) {
                const char = fingerprint.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            return `session_${Math.abs(hash).toString(16)}`;
        }
    } catch {
        // JSON parse failed, no fingerprint
    }
    return undefined;
}

// ============================================================================
// Plugin Activation
// ============================================================================

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, storage, providers, commands, ui } = context;

    logger.info('Antigravity Auth plugin activating...');

    // Initialize token store
    const tokenStore = new TokenStore(storage.secrets, logger);
    await tokenStore.initialize();

    // =========================================================================
    // Helper Functions
    // =========================================================================

    /**
     * Parse retry-after header to milliseconds
     */
    const parseRetryAfter = (response: Response): number => {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds)) {
                return seconds * 1000;
            }
        }
        return DEFAULT_RETRY_AFTER_MS;
    };

    /**
     * Determine model family from URL model string
     */
    const getModelFamilyFromUrl = (urlModel: string): ModelFamily => {
        return getModelFamily(urlModel) as ModelFamily;
    };

    // =========================================================================
    // Custom Fetch Wrapper
    // =========================================================================

    /**
     * Creates a custom fetch function that:
     * 1. Gets account with automatic rotation on rate limits
     * 2. Transforms request to Antigravity format
     * 3. Handles rate limiting with account rotation
     * 4. Handles response transformation
     */
    const createAntigravityFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
            }

            // Check if this is a Generative Language API request
            if (!isGenerativeLanguageRequest(url)) {
                // Not an Antigravity request, pass through
                return globalThis.fetch(input, init);
            }

            // Extract model from URL (Gemini SDK puts model in URL, not body)
            const urlModel = url.match(/\/models\/([^:/?]+)/)?.[1] || '';
            const modelFamily = getModelFamilyFromUrl(urlModel);

            // Get request body
            let body = init?.body;
            if (typeof body !== 'string') {
                throw new Error('Request body must be a string');
            }

            // Detect if this is an image generation request
            const isImage = isImageModel(urlModel);

            // Extract session fingerprint for conversation stickiness
            const sessionId = extractSessionFingerprint(body);

            // Try to make request with account rotation
            let lastError: Error | null = null;
            let lastResponse: Response | null = null;
            let attempts = 0;
            const maxAttempts = tokenStore.getAccountCount() * 2; // Allow 2 attempts per account

            while (attempts < maxAttempts) {
                attempts++;

                // Get account with full Antigravity-Manager logic:
                // - Session stickiness (same conversation uses same account)
                // - 60s global lock (non-image requests reuse account)
                // - Tier priority (ULTRA > PRO > FREE)
                let accountInfo: { accessToken: string; projectId: string; account: ManagedAccount; headerStyle: HeaderStyle };
                try {
                    accountInfo = await tokenStore.getValidAccessTokenForRequest(modelFamily, sessionId, isImage);
                } catch (error) {
                    // All accounts rate limited or no accounts
                    throw error;
                }

                const { accessToken, projectId, account, headerStyle } = accountInfo;

                logger.info(`URL model: ${urlModel}, family: ${modelFamily}, headerStyle: ${headerStyle}, account: ${account.index} (${account.email || 'unknown'}), session: ${sessionId?.slice(0, 12) || 'none'}, isImage: ${isImage}`);

                // Try endpoints with fallback
                for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
                    try {
                        const transformed = transformRequest(
                            url,
                            body,
                            accessToken,
                            projectId,
                            headerStyle,
                            endpoint,
                            logger
                        );

                        logger.info(`Sending request to ${endpoint}, model=${transformed.effectiveModel}, streaming=${transformed.streaming}`);
                        logger.debug(`Project ID: ${projectId}`);
                        logger.debug(`Request URL: ${transformed.url}`);

                        // Make the request
                        const response = await globalThis.fetch(transformed.url, {
                            method: 'POST',
                            headers: transformed.headers,
                            body: transformed.body,
                        });

                        // Handle rate limiting - mark account and retry with next
                        if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
                            const errorText = await response.clone().text();
                            const rateLimitReason = parseRateLimitReason(errorText);

                            // Try to parse retry delay from error body first, then fall back to header
                            let retryAfterMs = parseRetryDelay(errorText);
                            if (retryAfterMs === undefined) {
                                retryAfterMs = parseRetryAfter(response);
                            }

                            // Determine request type for quota tracking
                            const requestType: RequestType = isImage ? 'image_gen' : (modelFamily === 'claude' ? 'claude' : 'gemini');

                            logger.warn(`Rate limited at ${endpoint}, account ${account.index}, reason=${rateLimitReason}, requestType=${requestType}, retry after ${retryAfterMs}ms`);

                            // Mark this account as rate limited for this family/headerStyle/requestType
                            // For QUOTA_EXHAUSTED, use default (1 hour), for others use parsed or header value
                            await tokenStore.markRateLimited(
                                account,
                                rateLimitReason === 'quota_exhausted' ? undefined : retryAfterMs,
                                modelFamily,
                                headerStyle,
                                requestType,
                                rateLimitReason
                            );

                            // If we have more accounts, try next one
                            if (!tokenStore.getAccountManager().allAccountsRateLimited(modelFamily)) {
                                logger.info('Switching to next available account...');
                                break; // Break from endpoint loop to try next account
                            }

                            // All accounts rate limited, return error
                            const headers = new Headers(response.headers);
                            headers.set('retry-after', String(Math.ceil(retryAfterMs / 1000)));
                            return new Response(response.body, {
                                status: HTTP_STATUS.TOO_MANY_REQUESTS,
                                statusText: 'Too Many Requests',
                                headers,
                            });
                        }

                        // Handle server errors - try next endpoint
                        if (response.status >= HTTP_STATUS.SERVER_ERROR) {
                            const errorText = await response.clone().text();
                            logger.warn(`Server error at ${endpoint}: ${response.status}`, errorText);
                            lastResponse = response;
                            lastError = new Error(`Server error: ${response.status}`);
                            continue;
                        }

                        // Handle non-OK responses
                        if (!response.ok) {
                            const errorText = await response.clone().text();
                            logger.error(`Antigravity API error: ${response.status}`, errorText);
                            return response;
                        }

                        // Success! Transform response
                        if (transformed.streaming) {
                            return transformStreamingResponse(response, transformed.sessionId);
                        } else {
                            return await transformNonStreamingResponse(response, transformed.sessionId);
                        }
                    } catch (error) {
                        logger.error(`Error with endpoint ${endpoint}:`, error);
                        lastError = error instanceof Error ? error : new Error(String(error));
                        continue;
                    }
                }

                // If we got here due to rate limit, the outer while loop will try next account
                // Otherwise, all endpoints failed for this account
            }

            // All attempts failed
            if (lastResponse) {
                return lastResponse;
            }
            throw lastError || new Error('All Antigravity endpoints failed');
        };
    };

    // =========================================================================
    // Register Provider
    // =========================================================================

    const providerDisposable = providers.register({
        id: 'antigravity',
        name: 'Antigravity (Google)',
        description: 'Access Claude and Gemini models via your Antigravity subscription (supports multiple accounts)',
        authType: 'oauth',
        sdkType: 'google', // Use Google Generative AI SDK (Gemini format)

        async initialize() {
            logger.info('Antigravity provider initialized');
        },

        async isAuthenticated() {
            return tokenStore.hasValidToken();
        },

        async authenticate() {
            try {
                // Generate authorization URL
                const { url, verifier, state } = await getAuthorizationUrl();

                // Store state for code exchange
                await tokenStore.storePendingVerifier(verifier);
                await tokenStore.storePendingState(state);

                // Show notification
                const accountCount = tokenStore.getAccountCount();
                const message = accountCount > 0
                    ? `Adding another account (currently ${accountCount})...`
                    : 'Opening browser for Google login...';
                ui.showNotification(message, { type: 'info' });

                // Start OAuth flow with local callback server
                logger.info('Starting OAuth flow...');
                const result = await ui.startOAuthFlow({
                    authUrl: url,
                    callbackPort: 51121,
                    callbackPath: '/oauth-callback',
                    timeout: 300000, // 5 minutes
                });

                if (!result || !result.code) {
                    await tokenStore.clearPendingState();
                    return { success: false, error: 'Authorization cancelled or timed out' };
                }

                // Exchange code for tokens
                const pendingState = await tokenStore.getPendingState();
                if (!pendingState) {
                    return { success: false, error: 'No pending authorization. Please try again.' };
                }

                const tokens = await exchangeCodeForTokens(result.code, pendingState);
                await tokenStore.addAccount(tokens);
                await tokenStore.clearPendingState();

                const emailInfo = tokens.email ? ` (${tokens.email})` : '';
                const totalAccounts = tokenStore.getAccountCount();
                ui.showNotification(`Successfully connected to Antigravity${emailInfo}! Total accounts: ${totalAccounts}`, { type: 'success' });
                logger.info('Antigravity authentication successful');

                return { success: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logger.error('Antigravity authentication error:', error);
                ui.showError(`Authentication failed: ${message}`);
                return { success: false, error: message };
            }
        },

        async logout() {
            await tokenStore.clearTokens();
            ui.showNotification('Logged out from all Antigravity accounts', { type: 'info' });
            logger.info('Antigravity logout successful');
        },

        async getModels() {
            // Return all supported models
            return ANTIGRAVITY_MODELS.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description,
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxOutputTokens,
                capabilities: {
                    streaming: true,
                    reasoning: model.reasoning ?? isClaudeThinkingModel(model.id),
                    functionCalling: model.functionCalling ?? true,
                    imageOutput: model.imageOutput ?? false,
                },
                providerOptions: {
                    family: model.family,
                    thinking: model.thinking,
                    thinkingBudget: model.thinkingBudget,
                    baseModel: model.baseModel,
                },
            }));
        },

        /**
         * Returns SDK configuration for AI SDK's createGoogleGenerativeAI().
         */
        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: ANTIGRAVITY_BASE_URL,
                fetch: createAntigravityFetch(),
            };
        },

        // =====================================================================
        // Multi-Account Support
        // =====================================================================

        /** This provider supports multiple accounts */
        supportsMultiAccount: true,

        /**
         * Get list of connected accounts for UI display
         */
        async getAccounts() {
            const accounts = tokenStore.getAccountsInfo();
            return accounts.map(a => ({
                id: String(a.index),
                email: a.email,
                label: a.email || `Account ${a.index + 1}`,
                isRateLimited: a.isRateLimited,
                rateLimitResetAt: a.rateLimitResetAt,
            }));
        },

        /**
         * Remove a specific account by ID (index)
         */
        async removeAccount(accountId: string) {
            const index = parseInt(accountId, 10);
            if (isNaN(index)) {
                throw new Error(`Invalid account ID: ${accountId}`);
            }
            const removed = await tokenStore.removeAccount(index);
            if (!removed) {
                throw new Error(`Failed to remove account ${accountId}`);
            }
            logger.info(`Removed account ${accountId}`);
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const addAccountCommand = commands.register('add-account', async () => {
        // Trigger authentication flow to add another account
        try {
            const { url, verifier, state } = await getAuthorizationUrl();
            await tokenStore.storePendingVerifier(verifier);
            await tokenStore.storePendingState(state);

            ui.showNotification('Opening browser to add another account...', { type: 'info' });

            const result = await ui.startOAuthFlow({
                authUrl: url,
                callbackPort: 51121,
                callbackPath: '/oauth-callback',
                timeout: 300000,
            });

            if (!result || !result.code) {
                await tokenStore.clearPendingState();
                ui.showNotification('Account addition cancelled', { type: 'warning' });
                return;
            }

            const pendingState = await tokenStore.getPendingState();
            if (!pendingState) {
                ui.showError('No pending authorization');
                return;
            }

            const tokens = await exchangeCodeForTokens(result.code, pendingState);
            await tokenStore.addAccount(tokens);
            await tokenStore.clearPendingState();

            const emailInfo = tokens.email ? ` (${tokens.email})` : '';
            ui.showNotification(`Added account${emailInfo}! Total: ${tokenStore.getAccountCount()}`, { type: 'success' });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to add account';
            ui.showError(message);
        }
    });

    const listAccountsCommand = commands.register('accounts', async () => {
        const accounts = tokenStore.getAccountsInfo();
        if (accounts.length === 0) {
            ui.showNotification('No accounts connected', { type: 'warning' });
            return;
        }

        const accountList = accounts.map((a, i) =>
            `${i + 1}. ${a.email || 'Unknown'} (${a.projectId.slice(0, 12)}...)`
        ).join('\n');

        ui.showNotification(`Connected accounts (${accounts.length}):\n${accountList}`, { type: 'info' });
    });

    const removeAccountCommand = commands.register('remove-account', async () => {
        const accounts = tokenStore.getAccountsInfo();
        if (accounts.length === 0) {
            ui.showNotification('No accounts to remove', { type: 'warning' });
            return;
        }

        if (accounts.length === 1) {
            // Only one account, just remove it
            await tokenStore.removeAccount(0);
            ui.showNotification('Removed the only account', { type: 'info' });
            return;
        }

        // Show accounts and ask user to choose
        // For now, just remove the last account (user can use logout to remove all)
        const lastAccount = accounts[accounts.length - 1];
        await tokenStore.removeAccount(lastAccount.index);
        ui.showNotification(`Removed account: ${lastAccount.email || 'Unknown'}`, { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const accountCount = tokenStore.getAccountCount();

        if (accountCount === 0) {
            ui.showNotification('Not connected to Antigravity', { type: 'warning' });
            return;
        }

        const accounts = tokenStore.getAccountsInfo();
        const accountList = accounts.map(a => a.email || 'Unknown').join(', ');
        ui.showNotification(`Connected to Antigravity with ${accountCount} account(s): ${accountList}`, { type: 'success' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from all Antigravity accounts', { type: 'info' });
    });

    const clearRateLimitsCommand = commands.register('clear-rate-limits', {
        title: 'Clear Rate Limits',
        description: 'Clear all rate limit states from Antigravity accounts',
        handler: async () => {
            const accountManager = tokenStore.getAccountManager();
            const accounts = accountManager.getAccounts();
            let clearedCount = 0;
            for (const account of accounts) {
                const keys = Object.keys(account.rateLimitResetTimes);
                clearedCount += keys.length;
                for (const key of keys) {
                    delete account.rateLimitResetTimes[key as keyof typeof account.rateLimitResetTimes];
                }
            }
            await tokenStore.saveAccounts();
            logger.info(`Cleared ${clearedCount} rate limit(s) from ${accounts.length} account(s)`);
            ui.showNotification(`Cleared ${clearedCount} rate limit(s) from ${accounts.length} account(s)`, { type: 'success' });
        },
    });

    logger.info(`Antigravity Auth plugin activated with ${tokenStore.getAccountCount()} account(s)`);

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            providerDisposable.dispose();
            addAccountCommand.dispose();
            listAccountsCommand.dispose();
            removeAccountCommand.dispose();
            statusCommand.dispose();
            logoutCommand.dispose();
            clearRateLimitsCommand.dispose();
            logger.info('Antigravity Auth plugin deactivated');
        },
    };
}
