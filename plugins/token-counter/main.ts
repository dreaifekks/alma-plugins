import type { PluginContext, PluginActivation } from 'alma-plugin-api';

/**
 * Token Counter Plugin
 *
 * This plugin displays the current token count and estimated cost
 * in the status bar. It tracks tokens per-thread and uses real
 * pricing data from the model capabilities API.
 */

interface Pricing {
    input?: number;  // $ per million tokens
    output?: number;
    cacheRead?: number;
}

interface ThreadStats {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    cacheCost: number;
    totalCost: number;
    pricing?: Pricing;
}

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, events, ui, settings } = context;

    logger.info('Token Counter plugin activated!');

    // Create status bar item
    const statusBarItem = ui.createStatusBarItem({
        id: 'token-counter',
        alignment: 'right',
        priority: 100,
    });

    // Track token usage and cost per thread
    const threadStats = new Map<string, ThreadStats>();
    let currentThreadId: string | null = null;

    // Get settings
    const getSettings = () => ({
        showCost: settings.get<boolean>('tokenCounter.showCost', true),
        // Fallback cost per million tokens if no pricing data available
        fallbackCostPerMillion: settings.get<number>('tokenCounter.fallbackCostPerMillion', 3.0),
    });

    // Get stats for current thread
    const getCurrentStats = (): ThreadStats => {
        if (!currentThreadId) {
            return createEmptyStats();
        }
        return threadStats.get(currentThreadId) || createEmptyStats();
    };

    // Create empty stats object
    const createEmptyStats = (): ThreadStats => ({
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        inputCost: 0,
        outputCost: 0,
        cacheCost: 0,
        totalCost: 0,
    });

    // Calculate cost from tokens and pricing
    const calculateCost = (
        promptTokens: number,
        completionTokens: number,
        cachedTokens: number,
        pricing?: Pricing
    ): { inputCost: number; outputCost: number; cacheCost: number; totalCost: number } => {
        const { fallbackCostPerMillion } = getSettings();

        if (!pricing) {
            // Use fallback pricing for all tokens
            const totalCost = ((promptTokens + completionTokens) / 1_000_000) * fallbackCostPerMillion;
            return { inputCost: totalCost / 2, outputCost: totalCost / 2, cacheCost: 0, totalCost };
        }

        const inputCost = pricing.input ? (promptTokens / 1_000_000) * pricing.input : 0;
        const outputCost = pricing.output ? (completionTokens / 1_000_000) * pricing.output : 0;
        const cacheCost = pricing.cacheRead ? (cachedTokens / 1_000_000) * pricing.cacheRead : 0;
        const totalCost = inputCost + outputCost + cacheCost;

        return { inputCost, outputCost, cacheCost, totalCost };
    };

    // Update the status bar display
    const updateStatusBar = () => {
        const stats = getCurrentStats();
        const { showCost } = getSettings();

        if (stats.totalTokens === 0) {
            statusBarItem.text = 'Tokens: 0';
            statusBarItem.tooltip = 'No tokens used yet';
            return;
        }

        let text = `Tokens: ${formatNumber(stats.totalTokens)}`;

        if (showCost && stats.totalCost > 0) {
            text += ` ($${stats.totalCost.toFixed(4)})`;
        }

        statusBarItem.text = text;

        // Build detailed tooltip
        const tooltipLines = [
            `Input: ${formatNumber(stats.promptTokens)}`,
            `Output: ${formatNumber(stats.completionTokens)}`,
        ];

        if (stats.cachedTokens > 0) {
            tooltipLines.push(`Cached: ${formatNumber(stats.cachedTokens)}`);
        }

        tooltipLines.push(`Total: ${formatNumber(stats.totalTokens)}`);

        if (showCost && stats.totalCost > 0) {
            tooltipLines.push('');
            if (stats.pricing) {
                if (stats.inputCost > 0) tooltipLines.push(`Input cost: $${stats.inputCost.toFixed(4)}`);
                if (stats.outputCost > 0) tooltipLines.push(`Output cost: $${stats.outputCost.toFixed(4)}`);
                if (stats.cacheCost > 0) tooltipLines.push(`Cache cost: $${stats.cacheCost.toFixed(4)}`);
            }
            tooltipLines.push(`Total cost: $${stats.totalCost.toFixed(4)}`);

            if (stats.pricing) {
                tooltipLines.push('');
                tooltipLines.push(`Pricing: $${stats.pricing.input ?? '?'}/${stats.pricing.output ?? '?'} per 1M`);
            }
        }

        statusBarItem.tooltip = tooltipLines.join('\n');
    };

    // Format numbers with commas
    const formatNumber = (num: number): string => {
        return num.toLocaleString();
    };

    // Subscribe to message receive events to track token usage
    const messageDisposable = events.on('chat.message.didReceive', (input, _output) => {
        const { threadId, pricing } = input;
        currentThreadId = threadId;

        if (input.response.usage) {
            const usage = input.response.usage;
            const existing = threadStats.get(threadId) || createEmptyStats();

            // Update pricing if provided (use latest pricing)
            const currentPricing = pricing || existing.pricing;

            // Accumulate tokens
            const newPromptTokens = existing.promptTokens + usage.promptTokens;
            const newCompletionTokens = existing.completionTokens + usage.completionTokens;
            const newCachedTokens = existing.cachedTokens + (usage.cachedInputTokens ?? 0);
            const newTotalTokens = existing.totalTokens + usage.totalTokens;

            // Recalculate costs with current totals and pricing
            const costs = calculateCost(newPromptTokens, newCompletionTokens, newCachedTokens, currentPricing);

            threadStats.set(threadId, {
                promptTokens: newPromptTokens,
                completionTokens: newCompletionTokens,
                cachedTokens: newCachedTokens,
                totalTokens: newTotalTokens,
                ...costs,
                pricing: currentPricing,
            });

            logger.debug(`Token usage updated for thread ${threadId}: ${JSON.stringify(threadStats.get(threadId))}`);
            updateStatusBar();
        }
    });

    // Subscribe to thread activation events to update display when switching threads
    // This also initializes historical token usage from the database
    const threadDisposable = events.on('thread.activated', (input, _output) => {
        const { threadId, usage, pricing } = input;
        currentThreadId = threadId;

        // Initialize stats from historical usage if provided
        if (usage) {
            const cachedTokens = usage.cachedInputTokens ?? 0;
            const costs = calculateCost(usage.promptTokens, usage.completionTokens, cachedTokens, pricing);

            threadStats.set(threadId, {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                cachedTokens,
                totalTokens: usage.totalTokens,
                ...costs,
                pricing,
            });
            logger.debug(`Thread ${threadId} initialized with historical usage: ${JSON.stringify(threadStats.get(threadId))}`);
        }

        updateStatusBar();
    });

    // Initialize the status bar
    updateStatusBar();
    statusBarItem.show();

    // Listen for settings changes
    const settingsDisposable = settings.onDidChange(() => {
        // Recalculate costs when settings change
        for (const [threadId, stats] of threadStats.entries()) {
            const costs = calculateCost(stats.promptTokens, stats.completionTokens, stats.cachedTokens, stats.pricing);
            threadStats.set(threadId, { ...stats, ...costs });
        }
        updateStatusBar();
    });

    return {
        dispose: () => {
            logger.info('Token Counter plugin deactivated');
            messageDisposable.dispose();
            threadDisposable.dispose();
            settingsDisposable.dispose();
            statusBarItem.dispose();
        },
    };
}
