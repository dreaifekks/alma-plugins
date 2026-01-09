/**
 * Thinking Recovery Module
 *
 * When Claude's conversation history gets corrupted (thinking blocks stripped/malformed),
 * this module provides a "last resort" recovery by closing the current turn and starting fresh.
 *
 * Philosophy: "Let it crash and start again" - Instead of trying to fix corrupted state,
 * we abandon the corrupted turn and let Claude generate fresh thinking.
 *
 * Based on opencode-antigravity-auth's thinking-recovery.ts
 */

import type { GeminiContent, GeminiPart } from './types';

// ============================================================================
// Types
// ============================================================================

export interface ConversationState {
    /** True if we're in an incomplete tool use loop (ends with functionResponse) */
    inToolLoop: boolean;
    /** Index of first model message in current turn */
    turnStartIdx: number;
    /** Whether the TURN started with thinking */
    turnHasThinking: boolean;
    /** Index of last model message */
    lastModelIdx: number;
    /** Whether last model msg has thinking */
    lastModelHasThinking: boolean;
    /** Whether last model msg has tool calls */
    lastModelHasToolCalls: boolean;
}

// ============================================================================
// Detection Helpers
// ============================================================================

function isThinkingPart(part: GeminiPart): boolean {
    return part.thought === true;
}

function isFunctionResponsePart(part: GeminiPart): boolean {
    return 'functionResponse' in part && part.functionResponse !== undefined;
}

function isFunctionCallPart(part: GeminiPart): boolean {
    return 'functionCall' in part && part.functionCall !== undefined;
}

function isToolResultMessage(msg: GeminiContent): boolean {
    if (msg.role !== 'user') return false;
    return msg.parts?.some(isFunctionResponsePart) ?? false;
}

function messageHasThinking(msg: GeminiContent): boolean {
    return msg.parts?.some(isThinkingPart) ?? false;
}

function messageHasToolCalls(msg: GeminiContent): boolean {
    return msg.parts?.some(isFunctionCallPart) ?? false;
}

// ============================================================================
// Conversation State Analysis
// ============================================================================

/**
 * Analyzes conversation state to detect tool use loops and thinking mode issues.
 *
 * Key insight: A "turn" can span multiple assistant messages in a tool-use loop.
 * We need to find the TURN START (first assistant message after last real user message)
 * and check if THAT message had thinking, not just the last assistant message.
 */
export function analyzeConversationState(contents: GeminiContent[]): ConversationState {
    const state: ConversationState = {
        inToolLoop: false,
        turnStartIdx: -1,
        turnHasThinking: false,
        lastModelIdx: -1,
        lastModelHasThinking: false,
        lastModelHasToolCalls: false,
    };

    if (!contents || contents.length === 0) {
        return state;
    }

    // First pass: Find the last "real" user message (not a tool result)
    let lastRealUserIdx = -1;
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];
        if (msg.role === 'user' && !isToolResultMessage(msg)) {
            lastRealUserIdx = i;
        }
    }

    // Second pass: Analyze conversation and find turn boundaries
    for (let i = 0; i < contents.length; i++) {
        const msg = contents[i];

        if (msg.role === 'model') {
            const hasThinking = messageHasThinking(msg);
            const hasToolCalls = messageHasToolCalls(msg);

            // Track if this is the turn start
            if (i > lastRealUserIdx && state.turnStartIdx === -1) {
                state.turnStartIdx = i;
                state.turnHasThinking = hasThinking;
            }

            state.lastModelIdx = i;
            state.lastModelHasToolCalls = hasToolCalls;
            state.lastModelHasThinking = hasThinking;
        }
    }

    // Determine if we're in a tool loop
    // We're in a tool loop if the conversation ends with a tool result
    if (contents.length > 0) {
        const lastMsg = contents[contents.length - 1];
        if (lastMsg.role === 'user' && isToolResultMessage(lastMsg)) {
            state.inToolLoop = true;
        }
    }

    return state;
}

// ============================================================================
// Recovery Functions
// ============================================================================

/**
 * Strips all thinking blocks from messages.
 * Used before injecting synthetic messages to avoid invalid thinking patterns.
 */
function stripAllThinkingBlocks(contents: GeminiContent[]): GeminiContent[] {
    return contents.map(content => {
        if (!content.parts) return content;

        const filteredParts = content.parts.filter(part => !isThinkingPart(part));

        // If all parts were filtered out, keep at least one empty text part
        // (same as restoreThinkingSignatures does)
        if (filteredParts.length === 0) {
            return {
                ...content,
                parts: [{ text: '' }],
            };
        }

        return { ...content, parts: filteredParts };
    });
}

/**
 * Counts tool results at the end of the conversation.
 */
function countTrailingToolResults(contents: GeminiContent[]): number {
    let count = 0;

    for (let i = contents.length - 1; i >= 0; i--) {
        const msg = contents[i];

        if (msg.role === 'user') {
            const functionResponses = msg.parts?.filter(isFunctionResponsePart) ?? [];

            if (functionResponses.length > 0) {
                count += functionResponses.length;
            } else {
                break; // Real user message, stop counting
            }
        } else if (msg.role === 'model') {
            break; // Stop at the model that made the tool calls
        }
    }

    return count;
}

/**
 * Closes an incomplete tool loop by injecting synthetic messages to start a new turn.
 *
 * This is the "let it crash and start again" recovery mechanism.
 *
 * When we detect:
 * - We're in a tool loop (conversation ends with functionResponse)
 * - The tool call was made WITHOUT thinking (thinking was stripped/corrupted)
 * - We NOW want to enable thinking
 *
 * Instead of trying to fix the corrupted state, we:
 * 1. Strip ALL thinking blocks (removes any corrupted ones)
 * 2. Add synthetic MODEL message to complete the non-thinking turn
 * 3. Add synthetic USER message to start a NEW turn
 *
 * This allows Claude to generate fresh thinking for the new turn.
 */
export function closeToolLoopForThinking(contents: GeminiContent[]): GeminiContent[] {
    // Strip any old/corrupted thinking first
    const strippedContents = stripAllThinkingBlocks(contents);

    // Count tool results from the end of the conversation
    const toolResultCount = countTrailingToolResults(strippedContents);

    // Build synthetic model message content based on tool count
    let syntheticModelContent: string;
    if (toolResultCount === 0) {
        syntheticModelContent = '[Processing previous context.]';
    } else if (toolResultCount === 1) {
        syntheticModelContent = '[Tool execution completed.]';
    } else {
        syntheticModelContent = `[${toolResultCount} tool executions completed.]`;
    }

    // Step 1: Inject synthetic MODEL message to complete the non-thinking turn
    const syntheticModel: GeminiContent = {
        role: 'model',
        parts: [{ text: syntheticModelContent }],
    };

    // Step 2: Inject synthetic USER message to start a NEW turn
    const syntheticUser: GeminiContent = {
        role: 'user',
        parts: [{ text: '[Continue]' }],
    };

    return [...strippedContents, syntheticModel, syntheticUser];
}

/**
 * Checks if conversation state requires tool loop closure for thinking recovery.
 *
 * Returns true if:
 * - We're in a tool loop (state.inToolLoop)
 * - The turn didn't start with thinking (state.turnHasThinking === false)
 *
 * This is the trigger for the "let it crash and start again" recovery.
 */
export function needsThinkingRecovery(state: ConversationState): boolean {
    return state.inToolLoop && !state.turnHasThinking;
}
