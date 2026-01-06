/**
 * Antigravity Model Definitions
 *
 * Defines Claude and Gemini models available through Antigravity OAuth.
 * Based on opencode-antigravity-auth model resolution.
 */

import type { AntigravityModelInfo, ThinkingLevel } from './types';

// ============================================================================
// Model Definitions
// ============================================================================

export const ANTIGRAVITY_MODELS: AntigravityModelInfo[] = [
    // -------------------------------------------------------------------------
    // Claude Models (Thinking variants)
    // -------------------------------------------------------------------------
    {
        id: 'claude-sonnet-4-5-thinking',
        name: 'Claude Sonnet 4.5 (Thinking)',
        description: 'Claude Sonnet 4.5 with extended thinking enabled',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 10240,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5-thinking-high',
        name: 'Claude Sonnet 4.5 (High Thinking)',
        description: 'Claude Sonnet 4.5 with high thinking budget',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'high',
        thinkingBudget: 32768,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5-thinking-low',
        name: 'Claude Sonnet 4.5 (Low Thinking)',
        description: 'Claude Sonnet 4.5 with low thinking budget',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'low',
        thinkingBudget: 5120,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5-thinking-minimal',
        name: 'Claude Sonnet 4.5 (Minimal Thinking)',
        description: 'Claude Sonnet 4.5 with minimal thinking budget',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'minimal',
        thinkingBudget: 2048,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        description: 'Claude Sonnet 4.5 without thinking',
        baseModel: 'claude-sonnet-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },

    // -------------------------------------------------------------------------
    // Claude Opus 4.5 (Thinking variants)
    // -------------------------------------------------------------------------
    {
        id: 'claude-opus-4-5-thinking',
        name: 'Claude Opus 4.5 (Thinking)',
        description: 'Claude Opus 4.5 with extended thinking enabled',
        baseModel: 'claude-opus-4-5-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 10240,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-5-thinking-high',
        name: 'Claude Opus 4.5 (High Thinking)',
        description: 'Claude Opus 4.5 with high thinking budget',
        baseModel: 'claude-opus-4-5-thinking',
        family: 'claude',
        thinking: 'high',
        thinkingBudget: 32768,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-5-thinking-low',
        name: 'Claude Opus 4.5 (Low Thinking)',
        description: 'Claude Opus 4.5 with low thinking budget',
        baseModel: 'claude-opus-4-5-thinking',
        family: 'claude',
        thinking: 'low',
        thinkingBudget: 5120,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        description: 'Claude Opus 4.5 without thinking',
        baseModel: 'claude-opus-4-5',
        family: 'claude',
        thinking: 'none',
        contextWindow: 200000,
        maxOutputTokens: 8192,
    },

    // -------------------------------------------------------------------------
    // Gemini 2.5 Models
    // -------------------------------------------------------------------------
    {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: 'Gemini 2.5 Pro - advanced reasoning model',
        baseModel: 'gemini-2.5-pro-preview-06-05',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: 'Gemini 2.5 Flash - fast and efficient',
        baseModel: 'gemini-2.5-flash-preview-05-20',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 2.0 Models
    // -------------------------------------------------------------------------
    {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        description: 'Gemini 2.0 Flash - fast general purpose',
        baseModel: 'gemini-2.0-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
    },
    {
        id: 'gemini-2.0-flash-thinking',
        name: 'Gemini 2.0 Flash (Thinking)',
        description: 'Gemini 2.0 Flash with thinking enabled',
        baseModel: 'gemini-2.0-flash-thinking-exp-01-21',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 3.0 Models (Preview)
    // -------------------------------------------------------------------------
    {
        id: 'gemini-3.0-flash',
        name: 'Gemini 3.0 Flash',
        description: 'Gemini 3.0 Flash - next generation',
        baseModel: 'gemini-3.0-flash-preview',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get model info by ID
 */
export function getModelInfo(modelId: string): AntigravityModelInfo | undefined {
    return ANTIGRAVITY_MODELS.find((m) => m.id === modelId);
}

/**
 * Get the base model ID for API calls
 */
export function getBaseModelId(modelId: string): string {
    const model = getModelInfo(modelId);
    return model?.baseModel ?? modelId;
}

/**
 * Get model family (claude or gemini)
 */
export function getModelFamily(modelId: string): 'claude' | 'gemini' {
    const model = getModelInfo(modelId);
    if (model) {
        return model.family;
    }
    // Detect from model ID
    if (modelId.toLowerCase().includes('claude')) {
        return 'claude';
    }
    return 'gemini';
}

/**
 * Check if model is a Claude thinking model
 */
export function isClaudeThinkingModel(modelId: string): boolean {
    const model = getModelInfo(modelId);
    if (model) {
        return model.family === 'claude' && model.thinking !== 'none' && model.thinking !== undefined;
    }
    // Fallback detection from model ID
    const lower = modelId.toLowerCase();
    return lower.includes('claude') && lower.includes('thinking');
}

/**
 * Get thinking budget for a model
 */
export function getThinkingBudget(modelId: string): number | undefined {
    const model = getModelInfo(modelId);
    return model?.thinkingBudget;
}

/**
 * Get thinking level for a model
 */
export function getThinkingLevel(modelId: string): ThinkingLevel {
    const model = getModelInfo(modelId);
    return model?.thinking ?? 'none';
}

/**
 * Parse model ID with tier suffix (e.g., claude-sonnet-4-5-thinking-high)
 * Returns the base model and thinking tier
 */
export function parseModelWithTier(modelId: string): {
    baseModel: string;
    thinkingLevel: ThinkingLevel;
    thinkingBudget?: number;
} {
    const model = getModelInfo(modelId);
    if (model) {
        return {
            baseModel: model.baseModel,
            thinkingLevel: model.thinking ?? 'none',
            thinkingBudget: model.thinkingBudget,
        };
    }

    // Fallback: try to parse tier suffix
    const tierMap: Record<string, { level: ThinkingLevel; budget: number }> = {
        '-high': { level: 'high', budget: 32768 },
        '-medium': { level: 'medium', budget: 10240 },
        '-low': { level: 'low', budget: 5120 },
        '-minimal': { level: 'minimal', budget: 2048 },
    };

    for (const [suffix, config] of Object.entries(tierMap)) {
        if (modelId.endsWith(suffix)) {
            return {
                baseModel: modelId.slice(0, -suffix.length),
                thinkingLevel: config.level,
                thinkingBudget: config.budget,
            };
        }
    }

    return {
        baseModel: modelId,
        thinkingLevel: 'none',
    };
}
