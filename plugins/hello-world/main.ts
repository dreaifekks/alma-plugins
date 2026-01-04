import type { PluginContext, PluginActivation } from '@anthropic-ai/alma-plugin-api';

/**
 * Hello World Plugin
 *
 * This is a simple example plugin that demonstrates the basic structure
 * of an Alma plugin. It registers a tool and a command that greet the user.
 */

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, tools, commands, ui } = context;

    logger.info('Hello World plugin activated!');

    // Register a tool that can be used by the AI assistant
    const toolDisposable = tools.register('hello-world.greet', {
        name: 'Greet',
        description: 'Say hello to the user with a personalized message',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'The name of the person to greet',
                },
                language: {
                    type: 'string',
                    enum: ['en', 'zh', 'ja', 'es', 'fr'],
                    description: 'The language to use for the greeting',
                    default: 'en',
                },
            },
            required: ['name'],
        },
        execute: async (args) => {
            const { name, language = 'en' } = args as { name: string; language?: string };

            const greetings: Record<string, string> = {
                en: `Hello, ${name}! Welcome to Alma!`,
                zh: `你好，${name}！欢迎使用 Alma！`,
                ja: `こんにちは、${name}さん！Almaへようこそ！`,
                es: `¡Hola, ${name}! ¡Bienvenido a Alma!`,
                fr: `Bonjour, ${name}! Bienvenue sur Alma!`,
            };

            const greeting = greetings[language] || greetings.en;

            logger.info(`Greeting ${name} in ${language}`);

            return {
                success: true,
                message: greeting,
            };
        },
    });

    // Register a command that can be triggered from the command palette
    const commandDisposable = commands.register('hello-world.sayHello', async () => {
        ui.showNotification('Hello from the Hello World plugin!', {
            type: 'info',
        });
    });

    // Return disposables for cleanup when the plugin is deactivated
    return {
        dispose: () => {
            logger.info('Hello World plugin deactivated');
            toolDisposable.dispose();
            commandDisposable.dispose();
        },
    };
}
