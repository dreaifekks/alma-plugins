/**
 * Antigravity Auth Plugin for Alma
 *
 * Enables using Google Antigravity subscription to access Claude and Gemini models
 * via OAuth authentication. This plugin registers a custom provider that handles
 * authentication and API calls to the Antigravity backend.
 *
 * Based on opencode-antigravity-auth and follows openai-codex-auth patterns.
 *
 * DISCLAIMER: This plugin is for personal development use only with your
 * own Antigravity subscription. Not for commercial resale or multi-user services.
 */

import type { PluginContext, PluginActivation } from 'alma-plugin-api';
import { TokenStore } from './lib/token-store';
import { getAuthorizationUrl, exchangeCodeForTokens } from './lib/auth';
import { ANTIGRAVITY_MODELS, getModelFamily, isClaudeThinkingModel, parseModelWithTier } from './lib/models';
import {
    isGenerativeLanguageRequest,
    transformRequest,
    transformStreamingResponse,
    transformNonStreamingResponse,
    ANTIGRAVITY_ENDPOINTS,
    PRIMARY_ENDPOINT,
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
    // Custom Fetch Wrapper
    // =========================================================================

    /**
     * Map rate limit responses
     */
    const handleRateLimitResponse = async (response: Response): Promise<Response | null> => {
        if (response.status !== HTTP_STATUS.TOO_MANY_REQUESTS) return null;

        // Extract retry-after info if available
        const retryAfter = response.headers.get('retry-after');
        const headers = new Headers(response.headers);

        if (retryAfter) {
            headers.set('retry-after', retryAfter);
        }

        logger.warn('Rate limited by Antigravity API');
        return new Response(response.body, {
            status: HTTP_STATUS.TOO_MANY_REQUESTS,
            statusText: 'Too Many Requests',
            headers,
        });
    };

    /**
     * Creates a custom fetch function that:
     * 1. Refreshes OAuth token if needed
     * 2. Transforms request to Antigravity format
     * 3. Adds OAuth headers
     * 4. Handles response transformation
     */
    const createAntigravityFetch = (): typeof globalThis.fetch => {
        return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            // Step 1: Get fresh access token
            const accessToken = await tokenStore.getValidAccessToken();
            const projectId = tokenStore.getProjectId();

            if (!projectId) {
                throw new Error('Project ID not found. Please re-authenticate.');
            }

            // Step 2: Extract URL string
            let url: string;
            if (typeof input === 'string') {
                url = input;
            } else if (input instanceof URL) {
                url = input.toString();
            } else {
                url = input.url;
            }

            // Step 3: Check if this is a Generative Language API request
            if (!isGenerativeLanguageRequest(url)) {
                // Not an Antigravity request, pass through
                return globalThis.fetch(input, init);
            }

            // Step 4: Transform request
            let body = init?.body;
            if (typeof body !== 'string') {
                throw new Error('Request body must be a string');
            }

            // Determine header style based on model
            let parsed: any;
            try {
                parsed = JSON.parse(body);
            } catch {
                throw new Error('Invalid request body JSON');
            }

            const modelFamily = getModelFamily(parsed.model || '');
            const headerStyle = modelFamily === 'claude' ? 'antigravity' : 'gemini-cli';

            // Try endpoints with fallback
            let lastError: Error | null = null;
            let lastResponse: Response | null = null;

            for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
                try {
                    const transformed = transformRequest(
                        url,
                        body,
                        accessToken,
                        projectId,
                        headerStyle,
                        endpoint
                    );

                    logger.debug(`Sending request to ${endpoint}, model=${transformed.effectiveModel}, streaming=${transformed.streaming}`);

                    // Step 5: Make the request
                    const response = await globalThis.fetch(transformed.url, {
                        method: 'POST',
                        headers: transformed.headers,
                        body: transformed.body,
                    });

                    // Step 6: Handle rate limiting
                    if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
                        const rateLimitResponse = await handleRateLimitResponse(response);
                        if (rateLimitResponse) {
                            logger.warn(`Rate limited at ${endpoint}, returning error`);
                            return rateLimitResponse;
                        }
                    }

                    // Step 7: Handle server errors - try next endpoint
                    if (response.status >= HTTP_STATUS.SERVER_ERROR) {
                        const errorText = await response.clone().text();
                        logger.warn(`Server error at ${endpoint}: ${response.status}`, errorText);
                        lastResponse = response;
                        lastError = new Error(`Server error: ${response.status}`);
                        continue;
                    }

                    // Step 8: Handle non-OK responses
                    if (!response.ok) {
                        const errorText = await response.clone().text();
                        logger.error(`Antigravity API error: ${response.status}`, errorText);
                        return response;
                    }

                    // Step 9: Transform response
                    if (transformed.streaming) {
                        return transformStreamingResponse(response);
                    } else {
                        return await transformNonStreamingResponse(response);
                    }
                } catch (error) {
                    logger.error(`Error with endpoint ${endpoint}:`, error);
                    lastError = error instanceof Error ? error : new Error(String(error));
                    continue;
                }
            }

            // All endpoints failed
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
        description: 'Access Claude and Gemini models via your Antigravity subscription',
        authType: 'oauth',

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
                ui.showNotification('Opening browser for Google login...', { type: 'info' });

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
                await tokenStore.saveTokens(tokens);
                await tokenStore.clearPendingState();

                const emailInfo = tokens.email ? ` (${tokens.email})` : '';
                ui.showNotification(`Successfully connected to Antigravity${emailInfo}!`, { type: 'success' });
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
            ui.showNotification('Logged out from Antigravity', { type: 'info' });
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
                    reasoning: isClaudeThinkingModel(model.id),
                    functionCalling: true,
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
         * This follows the openai-codex-auth pattern:
         * - apiKey: Dummy key (actual auth via OAuth)
         * - baseURL: Generative Language API URL
         * - fetch: Custom fetch that handles OAuth headers, request transformation, etc.
         */
        async getSDKConfig() {
            return {
                apiKey: DUMMY_API_KEY,
                baseURL: ANTIGRAVITY_BASE_URL,
                fetch: createAntigravityFetch(),
            };
        },
    });

    // =========================================================================
    // Register Commands
    // =========================================================================

    const loginCommand = commands.register('login', async () => {
        ui.showNotification('Use the provider settings to connect to Antigravity', { type: 'info' });
    });

    const logoutCommand = commands.register('logout', async () => {
        await tokenStore.clearTokens();
        ui.showNotification('Logged out from Antigravity', { type: 'info' });
    });

    const statusCommand = commands.register('status', async () => {
        const isAuth = tokenStore.hasValidToken();
        const email = tokenStore.getEmail();
        const projectId = tokenStore.getProjectId();

        if (isAuth) {
            const emailInfo = email ? ` (${email})` : '';
            const projectInfo = projectId ? ` Project: ${projectId.slice(0, 12)}...` : '';
            ui.showNotification(`Connected to Antigravity${emailInfo}${projectInfo}`, { type: 'success' });
        } else {
            ui.showNotification('Not connected to Antigravity', { type: 'warning' });
        }
    });

    logger.info('Antigravity Auth plugin activated');

    // =========================================================================
    // Cleanup
    // =========================================================================

    return {
        dispose: () => {
            providerDisposable.dispose();
            loginCommand.dispose();
            logoutCommand.dispose();
            statusCommand.dispose();
            logger.info('Antigravity Auth plugin deactivated');
        },
    };
}
