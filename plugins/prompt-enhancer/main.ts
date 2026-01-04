import type { PluginContext, PluginActivation } from '@anthropic-ai/alma-plugin-api';

/**
 * Prompt Enhancer Plugin
 *
 * This plugin automatically enhances prompts sent to the AI by adding
 * additional context, instructions, and formatting guidelines to improve
 * the quality of responses.
 */

type EnhancementMode = 'minimal' | 'standard' | 'detailed';

const enhancementTemplates: Record<EnhancementMode, string> = {
    minimal: `
Please provide clear, concise responses.
`,
    standard: `
## Response Guidelines
- Be clear and concise in your explanations
- Use code blocks with appropriate language tags when showing code
- Structure your response with headings when addressing multiple topics
- Provide practical examples when helpful
`,
    detailed: `
## Response Guidelines

### Communication Style
- Be clear, concise, and professional
- Use simple language and avoid unnecessary jargon
- Structure complex responses with headings and bullet points

### Code Standards
- Always use syntax-highlighted code blocks with appropriate language tags
- Include comments for complex logic
- Show complete, runnable examples when possible
- Mention any dependencies or prerequisites

### Problem Solving
- Break down complex problems into steps
- Explain your reasoning when making recommendations
- Offer alternatives when multiple approaches exist
- Highlight potential pitfalls or edge cases

### Formatting
- Use markdown formatting for better readability
- Use tables for comparing options
- Use blockquotes for important notes or warnings
`,
};

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, hooks, settings, commands, ui } = context;

    logger.info('Prompt Enhancer plugin activated!');

    // Get current settings
    const getSettings = () => ({
        enabled: settings.get<boolean>('promptEnhancer.enabled', true),
        mode: settings.get<EnhancementMode>('promptEnhancer.mode', 'standard'),
        addTimestamp: settings.get<boolean>('promptEnhancer.addTimestamp', false),
        customInstructions: settings.get<string>('promptEnhancer.customInstructions', ''),
    });

    // Build the enhancement text based on settings
    const buildEnhancement = (): string => {
        const config = getSettings();
        const parts: string[] = [];

        // Add base enhancement template
        const template = enhancementTemplates[config.mode];
        if (template) {
            parts.push(template.trim());
        }

        // Add timestamp if enabled
        if (config.addTimestamp) {
            const now = new Date();
            parts.push(`\nCurrent date and time: ${now.toISOString()}`);
        }

        // Add custom instructions if provided
        if (config.customInstructions.trim()) {
            parts.push(`\n## Custom Instructions\n${config.customInstructions.trim()}`);
        }

        return parts.join('\n');
    };

    // Register hook to transform system prompt
    const hookDisposable = hooks.register(
        'chat.system.transform',
        (input, output) => {
            const config = getSettings();

            if (!config.enabled) {
                logger.debug('Prompt enhancement disabled, skipping');
                return;
            }

            const enhancement = buildEnhancement();
            const enhancedPrompt = `${input.systemPrompt}\n\n${enhancement}`;

            output.systemPrompt = enhancedPrompt;

            logger.debug(`Enhanced system prompt for model ${input.model}`);
        },
        { priority: 50 } // Medium priority to allow other plugins to override
    );

    // Register toggle command
    const commandDisposable = commands.register('prompt-enhancer.toggle', async () => {
        const current = settings.get<boolean>('promptEnhancer.enabled', true);
        await settings.set('promptEnhancer.enabled', !current);

        const status = !current ? 'enabled' : 'disabled';
        ui.showNotification(`Prompt enhancement ${status}`, {
            type: 'info',
        });
    });

    return {
        dispose: () => {
            logger.info('Prompt Enhancer plugin deactivated');
            hookDisposable.dispose();
            commandDisposable.dispose();
        },
    };
}
