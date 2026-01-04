import type { PluginContext, PluginActivation } from '@anthropic-ai/alma-plugin-api';

/**
 * Catppuccin Theme Plugin
 *
 * Provides the beautiful Catppuccin color palette as themes for Alma.
 * Includes all four flavors: Mocha, Macchiato, Frappé, and Latte.
 *
 * @see https://github.com/catppuccin/catppuccin
 */

// Catppuccin color palettes
const palettes = {
    mocha: {
        rosewater: '#f5e0dc',
        flamingo: '#f2cdcd',
        pink: '#f5c2e7',
        mauve: '#cba6f7',
        red: '#f38ba8',
        maroon: '#eba0ac',
        peach: '#fab387',
        yellow: '#f9e2af',
        green: '#a6e3a1',
        teal: '#94e2d5',
        sky: '#89dceb',
        sapphire: '#74c7ec',
        blue: '#89b4fa',
        lavender: '#b4befe',
    },
    macchiato: {
        rosewater: '#f4dbd6',
        flamingo: '#f0c6c6',
        pink: '#f5bde6',
        mauve: '#c6a0f6',
        red: '#ed8796',
        maroon: '#ee99a0',
        peach: '#f5a97f',
        yellow: '#eed49f',
        green: '#a6da95',
        teal: '#8bd5ca',
        sky: '#91d7e3',
        sapphire: '#7dc4e4',
        blue: '#8aadf4',
        lavender: '#b7bdf8',
    },
    frappe: {
        rosewater: '#f2d5cf',
        flamingo: '#eebebe',
        pink: '#f4b8e4',
        mauve: '#ca9ee6',
        red: '#e78284',
        maroon: '#ea999c',
        peach: '#ef9f76',
        yellow: '#e5c890',
        green: '#a6d189',
        teal: '#81c8be',
        sky: '#99d1db',
        sapphire: '#85c1dc',
        blue: '#8caaee',
        lavender: '#babbf1',
    },
    latte: {
        rosewater: '#dc8a78',
        flamingo: '#dd7878',
        pink: '#ea76cb',
        mauve: '#8839ef',
        red: '#d20f39',
        maroon: '#e64553',
        peach: '#fe640b',
        yellow: '#df8e1d',
        green: '#40a02b',
        teal: '#179299',
        sky: '#04a5e5',
        sapphire: '#209fb5',
        blue: '#1e66f5',
        lavender: '#7287fd',
    },
};

type AccentColor = keyof typeof palettes.mocha;
type Flavor = keyof typeof palettes;

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, settings, ui } = context;

    logger.info('Catppuccin Theme plugin activated!');

    // Get the current accent color setting
    const getAccentColor = (): AccentColor => {
        return settings.get<AccentColor>('catppuccin.accentColor', 'mauve');
    };

    // Update theme accent color when setting changes
    const updateAccentColor = () => {
        const accent = getAccentColor();
        logger.info(`Accent color changed to: ${accent}`);

        // In a real implementation, this would update the CSS variables
        // or trigger a theme refresh with the new accent color
    };

    // Listen for settings changes
    const settingsDisposable = settings.onDidChange((key) => {
        if (key === 'catppuccin.accentColor') {
            updateAccentColor();
        }
    });

    // Listen for theme changes
    const themeDisposable = ui.theme.onChange((theme) => {
        if (theme.id.startsWith('catppuccin-')) {
            const flavor = theme.id.replace('catppuccin-', '') as Flavor;
            const accent = getAccentColor();
            logger.info(`Theme changed to Catppuccin ${flavor} with accent ${accent}`);

            // Apply the accent color from the palette
            const accentColor = palettes[flavor]?.[accent];
            if (accentColor) {
                logger.debug(`Applying accent color: ${accentColor}`);
            }
        }
    });

    return {
        dispose: () => {
            logger.info('Catppuccin Theme plugin deactivated');
            settingsDisposable.dispose();
            themeDisposable.dispose();
        },
    };
}
