/**
 * Type definitions for Antigravity Auth Plugin
 */

// ============================================================================
// OAuth Types
// ============================================================================

export interface AntigravityTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // Unix timestamp in milliseconds
    email?: string; // User email from Google OAuth
    project_id: string; // Antigravity project ID
}

export interface PKCEChallenge {
    verifier: string;
    challenge: string;
}

export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    tokenUrl: string;
    redirectUri: string;
    scopes: string[];
}

// ============================================================================
// Model Types
// ============================================================================

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';

export interface AntigravityModelInfo {
    id: string;
    name: string;
    description?: string;
    baseModel: string; // The actual model ID sent to API
    family: 'claude' | 'gemini';
    thinking?: ThinkingLevel; // For Claude thinking models
    thinkingBudget?: number; // Token budget for thinking
    contextWindow?: number;
    maxOutputTokens?: number;
    imageOutput?: boolean; // Model can generate images
    functionCalling?: boolean; // Model supports function/tool calling
    reasoning?: boolean; // Model supports reasoning/thinking
}

// ============================================================================
// API Types (Gemini Format)
// ============================================================================

export interface AntigravityRequestBody {
    project: string;
    model: string;
    request: GeminiRequest;
    userAgent?: string;
    requestId?: string;
    requestType?: string;
}

export interface GeminiRequest {
    contents: GeminiContent[];
    systemInstruction?: GeminiSystemInstruction;
    tools?: GeminiTool[];
    toolConfig?: GeminiToolConfig;
    generationConfig?: GeminiGenerationConfig;
    sessionId?: string;
}

export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

export interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
        id?: string;
    };
    functionResponse?: {
        name: string;
        response: unknown;
        id?: string;
    };
}

export interface GeminiSystemInstruction {
    role?: string;
    parts: Array<{ text: string }>;
}

export interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export interface GeminiToolConfig {
    functionCallingConfig?: {
        mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED';
    };
}

export type ImageSize = '4K' | '2K';

export interface GeminiGenerationConfig {
    thinkingConfig?: {
        include_thoughts?: boolean;
        includeThoughts?: boolean;
        thinking_budget?: number;
        thinkingBudget?: number;
        thinkingLevel?: string;
    };
    imageConfig?: {
        aspectRatio?: string; // e.g., '1:1', '16:9', '9:16', '4:3', '3:4', '21:9'
        imageSize?: ImageSize; // e.g., '4K', '2K'
    };
    maxOutputTokens?: number;
    max_output_tokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
}

// ============================================================================
// SSE Response Types
// ============================================================================

export interface AntigravitySSEEvent {
    candidates?: AntigravityCandidate[];
    usageMetadata?: AntigravityUsageMetadata;
    error?: { message: string; code?: string };
}

export interface AntigravityCandidate {
    content?: {
        role: string;
        parts: GeminiPart[];
    };
    finishReason?: string;
}

export interface AntigravityUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
}

// ============================================================================
// Header Styles
// ============================================================================

export type HeaderStyle = 'antigravity' | 'gemini-cli';

export interface AntigravityHeaders {
    'User-Agent': string;
    'X-Goog-Api-Client': string;
    'Client-Metadata': string;
}
