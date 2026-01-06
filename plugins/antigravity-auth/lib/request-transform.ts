/**
 * Request/Response Transformation for Antigravity
 *
 * With sdkType: 'google', Alma uses Google Generative AI SDK directly,
 * so requests already come in Gemini format. We just need to:
 * 1. Wrap requests in Antigravity envelope (project, model, request)
 * 2. Add Claude-specific thinking config
 * 3. Unwrap response envelope
 *
 * This follows the same pattern as opencode-antigravity-auth.
 */

import type {
    AntigravityRequestBody,
    GeminiRequest,
    GeminiGenerationConfig,
    HeaderStyle,
    AntigravityHeaders,
} from './types';
import { getModelFamily, isClaudeThinkingModel, parseModelWithTier } from './models';

// ============================================================================
// Constants
// ============================================================================

// Antigravity API endpoints (in fallback order)
export const ANTIGRAVITY_ENDPOINTS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://autopush-cloudcode-pa.sandbox.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
] as const;

export const PRIMARY_ENDPOINT = ANTIGRAVITY_ENDPOINTS[0];

// Headers for different quota types
export const ANTIGRAVITY_HEADERS: AntigravityHeaders = {
    'User-Agent': 'antigravity/1.11.5 windows/amd64',
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
};

export const GEMINI_CLI_HEADERS: AntigravityHeaders = {
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
};

// Claude thinking model max output tokens
const CLAUDE_THINKING_MAX_OUTPUT_TOKENS = 65536;

// ============================================================================
// Request URL Detection
// ============================================================================

/**
 * Check if this is a Generative Language API request
 */
export function isGenerativeLanguageRequest(url: string): boolean {
    return url.includes('generativelanguage.googleapis.com');
}

/**
 * Extract model from URL (e.g., /models/gemini-2.5-pro:generateContent)
 */
export function extractModelFromUrl(url: string): string | null {
    const match = url.match(/\/models\/([^:/?]+)/);
    return match?.[1] ?? null;
}

/**
 * Detect if this is a streaming request
 */
export function isStreamingRequest(url: string): boolean {
    return url.includes(':streamGenerateContent');
}

// ============================================================================
// Request Transformation
// ============================================================================

export interface TransformResult {
    url: string;
    body: string;
    headers: Headers;
    streaming: boolean;
    effectiveModel: string;
    projectId: string;
}

/**
 * Transform Gemini SDK request to Antigravity format.
 *
 * Since we use sdkType: 'google', requests come directly in Gemini format
 * from the AI SDK. We just need to:
 * 1. Extract model from URL
 * 2. Add Claude-specific thinking config
 * 3. Wrap in Antigravity envelope
 */
export function transformRequest(
    originalUrl: string,
    body: string,
    accessToken: string,
    projectId: string,
    headerStyle: HeaderStyle = 'antigravity',
    endpoint: string = PRIMARY_ENDPOINT,
    logger?: { debug: (msg: string, ...args: unknown[]) => void }
): TransformResult {
    // Parse the Gemini request body
    let geminiRequest: GeminiRequest;
    try {
        geminiRequest = JSON.parse(body);
    } catch {
        throw new Error('Invalid request body');
    }

    // Extract model from URL
    const urlModel = extractModelFromUrl(originalUrl);
    const requestedModel = urlModel || 'unknown';

    // Resolve model with thinking tier
    const { baseModel, thinkingLevel, thinkingBudget } = parseModelWithTier(requestedModel);
    const effectiveModel = baseModel;

    logger?.debug(`Model resolution: ${requestedModel} -> ${effectiveModel}, thinking=${thinkingLevel}, budget=${thinkingBudget}`);

    const family = getModelFamily(requestedModel);
    const isClaude = family === 'claude';
    const isThinking = isClaudeThinkingModel(requestedModel);
    const streaming = isStreamingRequest(originalUrl);

    // Configure Claude tool calling to use VALIDATED mode (only when tools are present)
    // When no tools, delete toolConfig (as shown in opencode's buildThinkingWarmupBody)
    if (isClaude) {
        if (geminiRequest.tools && geminiRequest.tools.length > 0) {
            if (!geminiRequest.toolConfig) {
                geminiRequest.toolConfig = {};
            }
            if (!geminiRequest.toolConfig.functionCallingConfig) {
                geminiRequest.toolConfig.functionCallingConfig = {};
            }
            geminiRequest.toolConfig.functionCallingConfig.mode = 'VALIDATED';
        } else {
            // Delete toolConfig when no tools (AI SDK might add it automatically)
            delete geminiRequest.toolConfig;
            delete geminiRequest.tools;
        }
    }

    // Add Claude-specific thinking config
    // IMPORTANT: Claude uses snake_case keys (include_thoughts, thinking_budget)
    // max_tokens must be greater than thinking.budget_tokens
    if (isThinking && thinkingBudget) {
        const generationConfig: GeminiGenerationConfig = geminiRequest.generationConfig || {};

        generationConfig.thinkingConfig = {
            include_thoughts: true,
            thinking_budget: thinkingBudget,
        };

        // Ensure maxOutputTokens > thinkingBudget (required by Claude API)
        const currentMax = generationConfig.maxOutputTokens || generationConfig.max_output_tokens || 0;
        if (currentMax <= thinkingBudget) {
            generationConfig.maxOutputTokens = thinkingBudget + 8192; // budget + reasonable output space
        }

        geminiRequest.generationConfig = generationConfig;
    }

    // Add thinking hint for Claude thinking models with tools
    if (isClaude && isThinking && geminiRequest.tools && geminiRequest.tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.';
        if (geminiRequest.systemInstruction) {
            geminiRequest.systemInstruction.parts.push({ text: hint });
        } else {
            geminiRequest.systemInstruction = { parts: [{ text: hint }] };
        }
    }

    // Add session ID for multi-turn conversations
    geminiRequest.sessionId = `alma-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Wrap in Antigravity envelope
    const antigravityBody: AntigravityRequestBody = {
        project: projectId,
        model: effectiveModel,
        request: geminiRequest,
        userAgent: 'antigravity',
        requestId: `alma-${crypto.randomUUID()}`,
    };

    // Build Antigravity URL
    const action = streaming ? 'streamGenerateContent' : 'generateContent';
    const url = `${endpoint}/v1internal:${action}${streaming ? '?alt=sse' : ''}`;

    // Build headers
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${accessToken}`);
    headers.set('Content-Type', 'application/json');

    const selectedHeaders = headerStyle === 'gemini-cli' ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;
    headers.set('User-Agent', selectedHeaders['User-Agent']);
    headers.set('X-Goog-Api-Client', selectedHeaders['X-Goog-Api-Client']);
    headers.set('Client-Metadata', selectedHeaders['Client-Metadata']);

    if (streaming) {
        headers.set('Accept', 'text/event-stream');
    }

    // Add interleaved thinking header for Claude thinking models
    if (isThinking) {
        headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
    }

    return {
        url,
        body: JSON.stringify(antigravityBody),
        headers,
        streaming,
        effectiveModel,
        projectId,
    };
}

// ============================================================================
// Response Transformation
// ============================================================================

/**
 * Transform Antigravity SSE response.
 * Unwraps the Antigravity envelope to return standard Gemini format.
 */
export function transformStreamingResponse(response: Response): Response {
    if (!response.body) {
        return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';

    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (!line.trim()) {
                    controller.enqueue(encoder.encode('\n'));
                    continue;
                }

                if (!line.startsWith('data: ')) {
                    controller.enqueue(encoder.encode(line + '\n'));
                    continue;
                }

                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') {
                    controller.enqueue(encoder.encode(line + '\n'));
                    continue;
                }

                try {
                    const data = JSON.parse(dataStr);
                    // Unwrap Antigravity envelope - return the inner response
                    const unwrapped = data.response || data;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrapped)}\n`));
                } catch {
                    // Pass through as-is if parsing fails
                    controller.enqueue(encoder.encode(line + '\n'));
                }
            }
        },
        flush(controller) {
            if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer + '\n'));
            }
        }
    });

    return new Response(response.body.pipeThrough(transformStream), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

/**
 * Transform non-streaming response from Antigravity.
 * Unwraps the Antigravity envelope to return standard Gemini format.
 */
export async function transformNonStreamingResponse(response: Response): Promise<Response> {
    const text = await response.text();

    try {
        const data = JSON.parse(text);
        // Unwrap Antigravity envelope - return the inner response
        const unwrapped = data.response || data;

        return new Response(JSON.stringify(unwrapped), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch {
        // Return original response if parsing fails
        return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }
}
