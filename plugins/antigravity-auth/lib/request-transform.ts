/**
 * Request/Response Transformation for Antigravity
 *
 * Transforms OpenAI-style requests to Gemini format for Antigravity API.
 * Based on opencode-antigravity-auth request transformation logic.
 */

import type {
    AntigravityRequestBody,
    GeminiRequest,
    GeminiContent,
    GeminiPart,
    GeminiTool,
    GeminiFunctionDeclaration,
    GeminiGenerationConfig,
    HeaderStyle,
    AntigravityHeaders,
} from './types';
import { getModelFamily, isClaudeThinkingModel, getThinkingBudget, parseModelWithTier } from './models';

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

// Placeholder for empty schemas (Claude VALIDATED mode requires at least one property)
const EMPTY_SCHEMA_PLACEHOLDER_NAME = '_placeholder';
const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = 'Placeholder. Always pass true.';

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
 * Extract model from URL
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
// OpenAI to Gemini Format Conversion
// ============================================================================

interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    name?: string;
}

interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
}

/**
 * Convert OpenAI messages to Gemini contents format
 */
function convertMessagesToContents(messages: OpenAIMessage[]): {
    contents: GeminiContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
} {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;

    for (const message of messages) {
        if (message.role === 'system') {
            // System message goes to systemInstruction
            const text = typeof message.content === 'string'
                ? message.content
                : message.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n');

            if (systemInstruction) {
                systemInstruction.parts.push({ text });
            } else {
                systemInstruction = { parts: [{ text }] };
            }
            continue;
        }

        const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
        const parts: GeminiPart[] = [];

        // Handle content
        if (typeof message.content === 'string') {
            if (message.content) {
                parts.push({ text: message.content });
            }
        } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                    parts.push({ text: block.text });
                }
                // Image handling would go here if needed
            }
        }

        // Handle tool calls (from assistant)
        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                let args: Record<string, unknown> = {};
                try {
                    args = JSON.parse(toolCall.function.arguments);
                } catch {
                    // Keep empty args
                }
                parts.push({
                    functionCall: {
                        name: toolCall.function.name,
                        args,
                        id: toolCall.id,
                    },
                });
            }
        }

        // Handle tool response (from user with tool_call_id)
        if (message.role === 'user' && message.tool_call_id) {
            // This is a tool result, not a regular user message
            // Find the corresponding function call
            const responseContent = typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content);

            parts.push({
                functionResponse: {
                    name: message.name || 'unknown',
                    response: { result: responseContent },
                    id: message.tool_call_id,
                },
            });
        }

        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    }

    return { contents, systemInstruction };
}

/**
 * Convert OpenAI tools to Gemini function declarations
 */
function convertToolsToFunctionDeclarations(tools: OpenAITool[], isClaude: boolean): GeminiTool[] {
    const functionDeclarations: GeminiFunctionDeclaration[] = [];

    for (const tool of tools) {
        if (tool.type !== 'function') continue;

        let parameters = tool.function.parameters;

        // Claude VALIDATED mode requires at least one property
        if (isClaude) {
            parameters = cleanSchemaForClaude(parameters);
        }

        functionDeclarations.push({
            name: sanitizeToolName(tool.function.name),
            description: tool.function.description || '',
            parameters,
        });
    }

    if (functionDeclarations.length === 0) {
        return [];
    }

    return [{ functionDeclarations }];
}

/**
 * Sanitize tool name (alphanumeric and underscores only)
 */
function sanitizeToolName(name: string): string {
    return String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Clean JSON schema for Claude VALIDATED mode
 */
function cleanSchemaForClaude(schema: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') {
        return createPlaceholderSchema();
    }

    const cleaned = cleanJSONSchema(schema);

    // Claude VALIDATED mode requires at least one property
    const hasProperties =
        cleaned.properties &&
        typeof cleaned.properties === 'object' &&
        Object.keys(cleaned.properties as object).length > 0;

    cleaned.type = 'object';

    if (!hasProperties) {
        cleaned.properties = {
            [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                type: 'boolean',
                description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
            },
        };
        cleaned.required = [EMPTY_SCHEMA_PLACEHOLDER_NAME];
    }

    return cleaned;
}

/**
 * Create a placeholder schema for empty parameters
 */
function createPlaceholderSchema(): Record<string, unknown> {
    return {
        type: 'object',
        properties: {
            [EMPTY_SCHEMA_PLACEHOLDER_NAME]: {
                type: 'boolean',
                description: EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION,
            },
        },
        required: [EMPTY_SCHEMA_PLACEHOLDER_NAME],
    };
}

/**
 * Clean JSON schema - remove unsupported fields
 */
function cleanJSONSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const allowedKeys = [
        'type', 'properties', 'required', 'items', 'enum', 'description',
        'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
        'additionalProperties', 'oneOf', 'anyOf', 'allOf',
    ];

    const cleaned: Record<string, unknown> = {};

    for (const key of allowedKeys) {
        if (key in schema) {
            const value = schema[key];
            if (key === 'properties' && typeof value === 'object' && value !== null) {
                const props: Record<string, unknown> = {};
                for (const [propName, propValue] of Object.entries(value as Record<string, unknown>)) {
                    if (typeof propValue === 'object' && propValue !== null) {
                        props[propName] = cleanJSONSchema(propValue as Record<string, unknown>);
                    } else {
                        props[propName] = propValue;
                    }
                }
                cleaned[key] = props;
            } else if (key === 'items' && typeof value === 'object' && value !== null) {
                cleaned[key] = cleanJSONSchema(value as Record<string, unknown>);
            } else {
                cleaned[key] = value;
            }
        }
    }

    return cleaned;
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
 * Transform OpenAI-style request to Antigravity format
 */
export function transformRequest(
    originalUrl: string,
    body: string,
    accessToken: string,
    projectId: string,
    headerStyle: HeaderStyle = 'antigravity',
    endpoint: string = PRIMARY_ENDPOINT
): TransformResult {
    let parsed: OpenAIRequestBody;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('Invalid request body');
    }

    const requestedModel = parsed.model;
    const { baseModel, thinkingLevel, thinkingBudget } = parseModelWithTier(requestedModel);
    const effectiveModel = baseModel;
    const family = getModelFamily(requestedModel);
    const isClaude = family === 'claude';
    const isThinking = isClaudeThinkingModel(requestedModel);
    const streaming = isStreamingRequest(originalUrl) || parsed.stream === true;

    // Convert messages to Gemini format
    const { contents, systemInstruction } = convertMessagesToContents(parsed.messages);

    // Build Gemini request
    const geminiRequest: GeminiRequest = {
        contents,
    };

    if (systemInstruction) {
        geminiRequest.systemInstruction = systemInstruction;

        // Add thinking hint for Claude thinking models with tools
        if (isThinking && parsed.tools && parsed.tools.length > 0) {
            const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
            geminiRequest.systemInstruction.parts.push({ text: hint });
        }
    }

    // Convert tools
    if (parsed.tools && parsed.tools.length > 0) {
        geminiRequest.tools = convertToolsToFunctionDeclarations(parsed.tools, isClaude);

        // Set tool config for Claude VALIDATED mode
        if (isClaude) {
            geminiRequest.toolConfig = {
                functionCallingConfig: {
                    mode: 'VALIDATED',
                },
            };
        }
    }

    // Build generation config
    const generationConfig: GeminiGenerationConfig = {};

    if (parsed.max_tokens) {
        generationConfig.maxOutputTokens = parsed.max_tokens;
    }
    if (parsed.temperature !== undefined) {
        generationConfig.temperature = parsed.temperature;
    }
    if (parsed.top_p !== undefined) {
        generationConfig.topP = parsed.top_p;
    }

    // Add thinking config for Claude thinking models
    if (isThinking && thinkingBudget) {
        generationConfig.thinkingConfig = {
            include_thoughts: true,
            thinking_budget: thinkingBudget,
        };
        // Ensure maxOutputTokens is large enough
        if (!generationConfig.maxOutputTokens || generationConfig.maxOutputTokens <= thinkingBudget) {
            generationConfig.maxOutputTokens = CLAUDE_THINKING_MAX_OUTPUT_TOKENS;
        }
    }

    if (Object.keys(generationConfig).length > 0) {
        geminiRequest.generationConfig = generationConfig;
    }

    // Add session ID for multi-turn conversations
    geminiRequest.sessionId = `alma-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Wrap in Antigravity format
    const antigravityBody: AntigravityRequestBody = {
        project: projectId,
        model: effectiveModel,
        request: geminiRequest,
        userAgent: 'antigravity',
        requestId: `alma-${crypto.randomUUID()}`,
    };

    // Build URL
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
 * Transform Antigravity SSE response to OpenAI format
 */
export function transformStreamingResponse(response: Response): Response {
    if (!response.body) {
        return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const text = decoder.decode(chunk, { stream: true });
            const lines = text.split('\n');

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') {
                    controller.enqueue(encoder.encode(line + '\n'));
                    continue;
                }

                try {
                    const data = JSON.parse(dataStr);
                    const transformed = transformSSEPayload(data);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(transformed)}\n\n`));
                } catch {
                    // Pass through as-is if parsing fails
                    controller.enqueue(encoder.encode(line + '\n'));
                }
            }
        },
    });

    return new Response(response.body.pipeThrough(transformStream), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

/**
 * Transform a single SSE payload from Gemini to OpenAI format
 */
function transformSSEPayload(data: any): any {
    // If already in OpenAI format, return as-is
    if (data.choices || data.object === 'chat.completion.chunk') {
        return data;
    }

    // Transform Gemini format to OpenAI format
    const candidates = data.candidates || [];
    const choices = candidates.map((candidate: any, index: number) => {
        const content = candidate.content || {};
        const parts = content.parts || [];

        let text = '';
        const toolCalls: any[] = [];

        for (const part of parts) {
            if (part.thought && part.text) {
                // Transform thinking part to reasoning
                // OpenAI format uses reasoning_content
            } else if (part.text) {
                text += part.text;
            } else if (part.functionCall) {
                toolCalls.push({
                    index: toolCalls.length,
                    id: part.functionCall.id || `call_${toolCalls.length}`,
                    type: 'function',
                    function: {
                        name: part.functionCall.name,
                        arguments: JSON.stringify(part.functionCall.args || {}),
                    },
                });
            }
        }

        const delta: any = {};
        if (text) {
            delta.content = text;
        }
        if (toolCalls.length > 0) {
            delta.tool_calls = toolCalls;
        }

        return {
            index,
            delta,
            finish_reason: candidate.finishReason?.toLowerCase() || null,
        };
    });

    return {
        object: 'chat.completion.chunk',
        choices,
        usage: data.usageMetadata ? {
            prompt_tokens: data.usageMetadata.promptTokenCount || 0,
            completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
            total_tokens: data.usageMetadata.totalTokenCount || 0,
        } : undefined,
    };
}

/**
 * Transform non-streaming response from Gemini to OpenAI format
 */
export async function transformNonStreamingResponse(response: Response): Promise<Response> {
    const text = await response.text();

    try {
        const data = JSON.parse(text);

        // If already in OpenAI format, return as-is
        if (data.choices || data.object === 'chat.completion') {
            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }

        // Handle wrapped response
        const responseData = data.response || data;

        const candidates = responseData.candidates || [];
        const choices = candidates.map((candidate: any, index: number) => {
            const content = candidate.content || {};
            const parts = content.parts || [];

            let text = '';
            const toolCalls: any[] = [];

            for (const part of parts) {
                if (part.text && !part.thought) {
                    text += part.text;
                } else if (part.functionCall) {
                    toolCalls.push({
                        id: part.functionCall.id || `call_${toolCalls.length}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {}),
                        },
                    });
                }
            }

            const message: any = {
                role: 'assistant',
                content: text || null,
            };
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }

            return {
                index,
                message,
                finish_reason: candidate.finishReason?.toLowerCase() || 'stop',
            };
        });

        const usage = responseData.usageMetadata || data.usageMetadata;
        const transformed = {
            object: 'chat.completion',
            choices,
            usage: usage ? {
                prompt_tokens: usage.promptTokenCount || 0,
                completion_tokens: usage.candidatesTokenCount || 0,
                total_tokens: usage.totalTokenCount || 0,
            } : undefined,
        };

        return new Response(JSON.stringify(transformed), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch {
        // Return original response if transformation fails
        return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }
}
