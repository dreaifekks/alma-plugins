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
    // Budgets based on opencode-antigravity-auth: { low: 8192, medium: 16384, high: 32768 }
    // -------------------------------------------------------------------------
    {
        id: 'claude-sonnet-4-5-thinking',
        name: 'Claude Sonnet 4.5 (Thinking)',
        description: 'Claude Sonnet 4.5 with extended thinking enabled',
        baseModel: 'claude-sonnet-4-5-thinking',
        family: 'claude',
        thinking: 'medium',
        thinkingBudget: 16384,
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
        thinkingBudget: 8192,
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
        thinkingBudget: 16384,
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
        thinkingBudget: 8192,
        contextWindow: 200000,
        maxOutputTokens: 65536,
    },
    // NOTE: claude-opus-4-5 (without thinking) is NOT supported by Antigravity API
    // Only thinking variants are available for Opus

    // -------------------------------------------------------------------------
    // Gemini 2.5 Models
    // -------------------------------------------------------------------------
    {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description: 'Gemini 2.5 Pro - advanced reasoning model',
        baseModel: 'gemini-2.5-pro',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: 'Gemini 2.5 Flash - fast and efficient',
        baseModel: 'gemini-2.5-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 3.0 Models
    // -------------------------------------------------------------------------
    {
        id: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        description: 'Gemini 3 Pro - latest generation',
        baseModel: 'gemini-3-pro',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },
    {
        id: 'gemini-3-flash',
        name: 'Gemini 3 Flash',
        description: 'Gemini 3 Flash - fast and efficient',
        baseModel: 'gemini-3-flash',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
    },

    // -------------------------------------------------------------------------
    // Gemini 3 Pro Image Models
    // Base model with aspect ratio variants
    // -------------------------------------------------------------------------
    {
        id: 'gemini-3-pro-image',
        name: 'Gemini 3 Pro (Image)',
        description: 'Gemini 3 Pro with image generation (1:1)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
    {
        id: 'gemini-3-pro-image-16x9',
        name: 'Gemini 3 Pro (Image 16:9)',
        description: 'Gemini 3 Pro with image generation (16:9 widescreen)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
    {
        id: 'gemini-3-pro-image-9x16',
        name: 'Gemini 3 Pro (Image 9:16)',
        description: 'Gemini 3 Pro with image generation (9:16 portrait)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
    {
        id: 'gemini-3-pro-image-4x3',
        name: 'Gemini 3 Pro (Image 4:3)',
        description: 'Gemini 3 Pro with image generation (4:3)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
    {
        id: 'gemini-3-pro-image-3x4',
        name: 'Gemini 3 Pro (Image 3:4)',
        description: 'Gemini 3 Pro with image generation (3:4 portrait)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
    {
        id: 'gemini-3-pro-image-21x9',
        name: 'Gemini 3 Pro (Image 21:9)',
        description: 'Gemini 3 Pro with image generation (21:9 ultra-wide)',
        baseModel: 'gemini-3-pro-image',
        family: 'gemini',
        contextWindow: 1048576,
        maxOutputTokens: 65536,
        imageOutput: true,
    },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Strip provider prefix from model ID (e.g., "antigravity:claude-sonnet-4-5" -> "claude-sonnet-4-5")
 */
export function stripProviderPrefix(modelId: string): string {
    const colonIndex = modelId.indexOf(':');
    if (colonIndex !== -1) {
        return modelId.slice(colonIndex + 1);
    }
    return modelId;
}

/**
 * Get model info by ID
 */
export function getModelInfo(modelId: string): AntigravityModelInfo | undefined {
    const cleanId = stripProviderPrefix(modelId);
    return ANTIGRAVITY_MODELS.find((m) => m.id === cleanId);
}

/**
 * Get the base model ID for API calls
 */
export function getBaseModelId(modelId: string): string {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    return model?.baseModel ?? cleanId;
}

/**
 * Get model family (claude or gemini)
 */
export function getModelFamily(modelId: string): 'claude' | 'gemini' {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.family;
    }
    // Detect from model ID
    if (cleanId.toLowerCase().includes('claude')) {
        return 'claude';
    }
    return 'gemini';
}

/**
 * Check if model is a Claude thinking model
 */
export function isClaudeThinkingModel(modelId: string): boolean {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.family === 'claude' && model.thinking !== 'none' && model.thinking !== undefined;
    }
    // Fallback detection from model ID
    const lower = cleanId.toLowerCase();
    return lower.includes('claude') && lower.includes('thinking');
}

/**
 * Get thinking budget for a model
 */
export function getThinkingBudget(modelId: string): number | undefined {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    return model?.thinkingBudget;
}

/**
 * Get thinking level for a model
 */
export function getThinkingLevel(modelId: string): ThinkingLevel {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    return model?.thinking ?? 'none';
}

/**
 * Check if a model is an image generation model
 */
export function isImageModel(modelId: string): boolean {
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return model.imageOutput === true;
    }
    // Fallback detection from model ID
    return cleanId.toLowerCase().includes('gemini-3-pro-image');
}

/**
 * Parse aspect ratio from image model ID
 * e.g., 'gemini-3-pro-image-16x9' -> '16:9'
 */
export function parseImageAspectRatio(modelId: string): string {
    const cleanId = stripProviderPrefix(modelId).toLowerCase();

    // Map of suffixes to aspect ratios
    const aspectRatioMap: Record<string, string> = {
        '-16x9': '16:9',
        '-9x16': '9:16',
        '-4x3': '4:3',
        '-3x4': '3:4',
        '-21x9': '21:9',
        '-1x1': '1:1',
    };

    for (const [suffix, ratio] of Object.entries(aspectRatioMap)) {
        if (cleanId.endsWith(suffix)) {
            return ratio;
        }
    }

    // Default aspect ratio
    return '1:1';
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
    const cleanId = stripProviderPrefix(modelId);
    const model = getModelInfo(cleanId);
    if (model) {
        return {
            baseModel: model.baseModel,
            thinkingLevel: model.thinking ?? 'none',
            thinkingBudget: model.thinkingBudget,
        };
    }

    // Fallback: try to parse tier suffix (budgets match opencode-antigravity-auth)
    const tierMap: Record<string, { level: ThinkingLevel; budget: number }> = {
        '-high': { level: 'high', budget: 32768 },
        '-medium': { level: 'medium', budget: 16384 },
        '-low': { level: 'low', budget: 8192 },
    };

    for (const [suffix, config] of Object.entries(tierMap)) {
        if (cleanId.endsWith(suffix)) {
            return {
                baseModel: cleanId.slice(0, -suffix.length),
                thinkingLevel: config.level,
                thinkingBudget: config.budget,
            };
        }
    }

    return {
        baseModel: cleanId,
        thinkingLevel: 'none',
    };
}
