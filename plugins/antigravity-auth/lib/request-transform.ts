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
    GeminiContent,
    GeminiPart,
    HeaderStyle,
    AntigravityHeaders,
} from './types';
import { getModelFamily, isClaudeThinkingModel, parseModelWithTier, isImageModel, parseImageAspectRatio, parseImageSize } from './models';
import { cacheSignature, getCachedSignature } from './signature-cache';
import { sanitizeToolsForAntigravity } from './schema-sanitizer';
import { analyzeConversationState, closeToolLoopForThinking, needsThinkingRecovery } from './thinking-recovery';

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
    'User-Agent': 'antigravity/1.15.8 windows/amd64',
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

/**
 * Map logical model names to physical model names for upstream compatibility
 * (matches Antigravity-Manager's common_utils.rs)
 *
 * Antigravity API only recognizes certain physical model names, so we need to
 * map our internal logical names back to what the API expects.
 */
export function mapToPhysicalModel(model: string): string {
    switch (model) {
        case 'gemini-3-pro-preview':
            return 'gemini-3-pro-high';  // Preview maps back to High
        case 'gemini-3-pro-image-preview':
            return 'gemini-3-pro-image';
        case 'gemini-3-flash-preview':
            return 'gemini-3-flash';
        default:
            return model;
    }
}

// ============================================================================
// Conversation Sanitization
// ============================================================================

/**
 * Restore signatures for thinking blocks in conversation history.
 * Claude requires a signature for thinking blocks in multi-turn conversations.
 * We try to restore signatures from cache; if not found, we strip the thinking block.
 *
 * Based on opencode-antigravity-auth's filterUnsignedThinkingBlocks.
 */
function restoreThinkingSignatures(contents: GeminiContent[], sessionId: string): GeminiContent[] {
    return contents.map(content => {
        if (!content.parts) return content;

        const processedParts: GeminiPart[] = [];

        for (const part of content.parts) {
            // Not a thinking block - keep as is
            if (part.thought !== true) {
                processedParts.push(part);
                continue;
            }

            // Already has signature - keep as is
            if (part.thoughtSignature) {
                processedParts.push(part);
                continue;
            }

            // Try to restore signature from cache
            const thinkingText = part.text || '';
            if (thinkingText) {
                const cachedSig = getCachedSignature(sessionId, thinkingText);
                if (cachedSig) {
                    // Restore signature
                    processedParts.push({
                        ...part,
                        thoughtSignature: cachedSig,
                    });
                    continue;
                }
            }

            // No signature and not in cache - skip this thinking block
            // (Claude will reject it without a signature)
        }

        // If all parts were filtered out, mark this content for removal
        if (processedParts.length === 0) {
            return null;
        }

        return {
            ...content,
            parts: processedParts,
        };
    }).filter((content): content is GeminiContent => content !== null);
}

/**
 * Ensure all functionCall parts have IDs and match functionResponse IDs.
 * Claude requires tool_use.id to match with tool_result.tool_use_id.
 *
 * Uses a two-pass approach like opencode-antigravity-auth:
 * 1. First pass: Assign IDs to all functionCalls and collect them in FIFO queues per function name
 * 2. Second pass: Match functionResponses to their corresponding calls using FIFO order
 */
function ensureToolIds(contents: GeminiContent[]): GeminiContent[] {
    let toolCallCounter = 0;
    // Track pending call IDs per function name as a FIFO queue
    const pendingCallIdsByName = new Map<string, string[]>();

    // First pass: assign IDs to all functionCalls and collect them
    const firstPassContents = contents.map(content => {
        if (!content.parts) return content;

        const processedParts = content.parts.map(part => {
            if (part.functionCall) {
                const call = { ...part.functionCall };
                if (!call.id) {
                    call.id = `tool-call-${++toolCallCounter}`;
                }
                const nameKey = call.name || `tool-${toolCallCounter}`;
                // Push to the queue for this function name
                const queue = pendingCallIdsByName.get(nameKey) || [];
                queue.push(call.id);
                pendingCallIdsByName.set(nameKey, queue);
                return { ...part, functionCall: call };
            }
            return part;
        });

        return { ...content, parts: processedParts };
    });

    // Second pass: match functionResponses to their corresponding calls (FIFO order)
    return firstPassContents.map(content => {
        if (!content.parts) return content;

        const processedParts = content.parts.map(part => {
            if (part.functionResponse) {
                const resp = { ...part.functionResponse };
                if (!resp.id && resp.name) {
                    const queue = pendingCallIdsByName.get(resp.name);
                    if (queue && queue.length > 0) {
                        // Consume the first pending ID (FIFO order)
                        resp.id = queue.shift();
                        pendingCallIdsByName.set(resp.name, queue);
                    }
                }
                return { ...part, functionResponse: resp };
            }
            return part;
        });

        return { ...content, parts: processedParts };
    });
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
    sessionId: string;
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

    // Map logical model names to physical model names for upstream compatibility
    // (matches Antigravity-Manager's common_utils.rs)
    const effectiveModel = mapToPhysicalModel(baseModel);

    logger?.debug(`Model resolution: ${requestedModel} -> ${baseModel} -> ${effectiveModel}, thinking=${thinkingLevel}, budget=${thinkingBudget}`);

    const family = getModelFamily(requestedModel);
    const isClaude = family === 'claude';
    const isThinking = isClaudeThinkingModel(requestedModel);
    const streaming = isStreamingRequest(originalUrl);

    // Restore thinking signatures from cache for Claude models
    // Claude requires signatures for thinking blocks in multi-turn conversations
    // We use sessionId from the request or generate one
    const sessionId = geminiRequest.sessionId || `alma-${Date.now()}`;
    if (isClaude && geminiRequest.contents) {
        geminiRequest.contents = restoreThinkingSignatures(geminiRequest.contents, sessionId);
        // Ensure all functionCall/functionResponse parts have matching IDs (required by Claude)
        geminiRequest.contents = ensureToolIds(geminiRequest.contents);
    }

    // Sanitize tool schemas for Claude (remove unsupported JSON Schema features)
    if (isClaude && geminiRequest.tools) {
        geminiRequest.tools = sanitizeToolsForAntigravity(geminiRequest.tools);
    }

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

    // Thinking recovery: "Let it crash and start again"
    // When Claude thinking model has corrupted conversation state (tool calls without thinking),
    // we close the current turn and start a new one so Claude can generate fresh thinking.
    if (isThinking && geminiRequest.contents) {
        const conversationState = analyzeConversationState(geminiRequest.contents);
        if (needsThinkingRecovery(conversationState)) {
            logger?.debug('Thinking recovery: closing tool loop and starting fresh turn');
            geminiRequest.contents = closeToolLoopForThinking(geminiRequest.contents);
        }
    }

    // [NEW] Antigravity 身份注入 (原始简化版)
    // Only inject for non-image generation requests
    const isImage = isImageModel(requestedModel);
    if (!isImage) {
        const antigravityIdentity = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**`;

        // [HYBRID] 检查用户是否已提供 Antigravity 身份
        let userHasAntigravity = false;
        if (geminiRequest.systemInstruction?.parts) {
            for (const part of geminiRequest.systemInstruction.parts) {
                if (part.text && part.text.includes('You are Antigravity')) {
                    userHasAntigravity = true;
                    logger?.debug(`[Identity] User already has Antigravity identity in systemInstruction`);
                    break;
                }
            }
        }

        // 如果用户没有提供 Antigravity 身份,则注入
        if (!userHasAntigravity) {
            if (geminiRequest.systemInstruction?.parts) {
                // 在前面插入 Antigravity 身份
                geminiRequest.systemInstruction.parts.unshift({ text: antigravityIdentity });
                logger?.debug(`[Identity] Injected Antigravity identity at beginning of existing systemInstruction`);
            } else {
                // 没有 systemInstruction,创建一个新的
                geminiRequest.systemInstruction = {
                    parts: [{ text: antigravityIdentity }],
                };
                logger?.debug(`[Identity] Created new systemInstruction with Antigravity identity`);
            }
        }
    } else {
        logger?.debug(`[Identity] Skipping identity injection for image model: ${requestedModel}`);
    }

    // Add image generation config for Gemini image models
    if (isImage) {
        const aspectRatio = parseImageAspectRatio(requestedModel);
        const imageSize = parseImageSize(requestedModel);
        const generationConfig: GeminiGenerationConfig = geminiRequest.generationConfig || {};

        // Add imageConfig for aspect ratio and size
        generationConfig.imageConfig = {
            aspectRatio,
            ...(imageSize && { imageSize }),
        };

        geminiRequest.generationConfig = generationConfig;

        logger?.debug(`Image generation config: model=${requestedModel}, aspectRatio=${aspectRatio}, imageSize=${imageSize ?? 'default'}`);
    }

    // Add session ID for multi-turn conversations
    geminiRequest.sessionId = `alma-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Ensure systemInstruction has role set (required by Antigravity API)
    if (geminiRequest.systemInstruction) {
        geminiRequest.systemInstruction.role = 'user';
    }

    // Wrap in Antigravity envelope
    const antigravityBody: AntigravityRequestBody = {
        project: projectId,
        model: effectiveModel,
        request: geminiRequest,
        userAgent: 'antigravity',
        requestId: `alma-${crypto.randomUUID()}`,
        requestType: 'agent',
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
        sessionId,
    };
}

// ============================================================================
// Response Transformation
// ============================================================================

/**
 * Transform Antigravity SSE response.
 * Unwraps the Antigravity envelope to return standard Gemini format.
 * Caches thinking block signatures for multi-turn conversations.
 */
export function transformStreamingResponse(response: Response, sessionId?: string): Response {
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

                    // Cache thinking signatures for multi-turn conversations
                    if (sessionId && unwrapped.candidates) {
                        for (const candidate of unwrapped.candidates) {
                            if (candidate.content?.parts) {
                                for (const part of candidate.content.parts) {
                                    // Cache Gemini-style thinking (thought: true with thoughtSignature)
                                    if (part.thought === true && part.text && part.thoughtSignature) {
                                        cacheSignature(sessionId, part.text, part.thoughtSignature);
                                    }
                                }
                            }
                        }
                    }

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
 * Caches thinking block signatures for multi-turn conversations.
 */
export async function transformNonStreamingResponse(response: Response, sessionId?: string): Promise<Response> {
    const text = await response.text();

    try {
        const data = JSON.parse(text);
        // Unwrap Antigravity envelope - return the inner response
        const unwrapped = data.response || data;

        // Cache thinking signatures for multi-turn conversations
        if (sessionId && unwrapped.candidates) {
            for (const candidate of unwrapped.candidates) {
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.thought === true && part.text && part.thoughtSignature) {
                            cacheSignature(sessionId, part.text, part.thoughtSignature);
                        }
                    }
                }
            }
        }

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
