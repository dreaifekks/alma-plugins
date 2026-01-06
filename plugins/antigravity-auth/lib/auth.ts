/**
 * OAuth Authentication for Antigravity
 *
 * Implements Google OAuth2 PKCE flow to authenticate with Antigravity API.
 * Based on opencode-antigravity-auth implementation.
 */

import type { PKCEChallenge, OAuthConfig, AntigravityTokens } from './types';

// ============================================================================
// OAuth Configuration (from opencode-antigravity-auth)
// ============================================================================

export const OAUTH_CONFIG: OAuthConfig = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    redirectUri: 'http://localhost:51121/oauth-callback',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs',
    ],
};

// Default project ID when Antigravity doesn't return one
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

// ============================================================================
// PKCE Helpers
// ============================================================================

/**
 * Generate a random string for PKCE verifier
 */
function generateRandomString(length: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
        result += chars[randomValues[i] % chars.length];
    }
    return result;
}

/**
 * Generate SHA-256 hash and base64url encode it
 */
async function sha256Base64Url(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    // Convert to base64url
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate PKCE challenge and verifier
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
    const verifier = generateRandomString(64);
    const challenge = await sha256Base64Url(verifier);
    return { verifier, challenge };
}

// ============================================================================
// State Encoding (for OAuth state parameter)
// ============================================================================

interface AuthState {
    verifier: string;
    projectId: string;
}

/**
 * Encode state object into base64url string
 */
function encodeState(payload: AuthState): string {
    const json = JSON.stringify(payload);
    // Use btoa for browser compatibility, handle unicode
    const base64 = btoa(unescape(encodeURIComponent(json)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode state parameter back to object
 */
export function decodeState(state: string): AuthState {
    const normalized = state.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const json = decodeURIComponent(escape(atob(padded)));
    const parsed = JSON.parse(json);
    if (typeof parsed.verifier !== 'string') {
        throw new Error('Missing PKCE verifier in state');
    }
    return {
        verifier: parsed.verifier,
        projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
    };
}

// ============================================================================
// OAuth Flow
// ============================================================================

/**
 * Generate the authorization URL with PKCE challenge
 */
export async function getAuthorizationUrl(projectId = ''): Promise<{ url: string; verifier: string; state: string }> {
    const pkce = await generatePKCE();
    const state = encodeState({ verifier: pkce.verifier, projectId });

    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        response_type: 'code',
        redirect_uri: OAUTH_CONFIG.redirectUri,
        scope: OAUTH_CONFIG.scopes.join(' '),
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
    });

    const url = `${OAUTH_CONFIG.authUrl}?${params.toString()}`;

    return { url, verifier: pkce.verifier, state };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
    code: string,
    state: string
): Promise<AntigravityTokens> {
    const { verifier, projectId } = decodeState(state);
    const startTime = Date.now();

    const body = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: OAUTH_CONFIG.redirectUri,
        code_verifier: verifier,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();

    if (!data.refresh_token) {
        throw new Error('Missing refresh token in response');
    }

    // Get user info for email
    const userInfo = await fetchUserInfo(data.access_token);

    // Get project ID if not provided
    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
        effectiveProjectId = await fetchProjectId(data.access_token);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: startTime + data.expires_in * 1000,
        email: userInfo.email,
        project_id: effectiveProjectId || DEFAULT_PROJECT_ID,
    };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshTokens(refreshToken: string, projectId: string): Promise<AntigravityTokens> {
    const startTime = Date.now();

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
    });

    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
    }

    const data = await response.json();

    // Get user info for email
    const userInfo = await fetchUserInfo(data.access_token);

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken, // Keep old refresh token if not provided
        expires_at: startTime + data.expires_in * 1000,
        email: userInfo.email,
        project_id: projectId,
    };
}

// ============================================================================
// User Info & Project ID
// ============================================================================

/**
 * Fetch user info from Google API
 */
async function fetchUserInfo(accessToken: string): Promise<{ email?: string }> {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });

        if (!response.ok) {
            return {};
        }

        const data = await response.json();
        return { email: data.email };
    } catch {
        return {};
    }
}

/**
 * Fetch Antigravity project ID from loadCodeAssist endpoint
 */
async function fetchProjectId(accessToken: string): Promise<string> {
    const endpoints = [
        'https://cloudcode-pa.googleapis.com',
        'https://daily-cloudcode-pa.sandbox.googleapis.com',
        'https://autopush-cloudcode-pa.sandbox.googleapis.com',
    ];

    const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
    };

    for (const baseEndpoint of endpoints) {
        try {
            const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI',
                    },
                }),
            });

            if (!response.ok) {
                continue;
            }

            const data = await response.json();
            if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
                return data.cloudaicompanionProject;
            }
            if (
                data.cloudaicompanionProject &&
                typeof data.cloudaicompanionProject.id === 'string' &&
                data.cloudaicompanionProject.id
            ) {
                return data.cloudaicompanionProject.id;
            }
        } catch {
            // Continue to next endpoint
        }
    }

    return '';
}

// ============================================================================
// Token Utilities
// ============================================================================

/**
 * Check if a token is expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(expiresAt: number, bufferMs: number = 5 * 60 * 1000): boolean {
    return Date.now() >= expiresAt - bufferMs;
}
