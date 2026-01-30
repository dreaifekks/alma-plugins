const DEFAULT_ANTIGRAVITY_VERSION = '1.15.8';
const VERSION_TIMEOUT_MS = 3000;
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_REGEX = /\b(\d+\.\d+\.\d+)\b/;
const UA_VERSION_REGEX = /antigravity\/(\d+\.\d+\.\d+)/i;

let cachedVersion = DEFAULT_ANTIGRAVITY_VERSION;
let lastFetchedAt = 0;
let refreshInFlight: Promise<void> | null = null;

const VERSION_URLS = [
    'https://antigravity-auto-updater-974169037036.us-central1.run.app',
] as const;

function getVersionUrls(): string[] {
    return [...VERSION_URLS];
}

function parseVersionFromText(text: string): string | null {
    const uaMatch = text.match(UA_VERSION_REGEX);
    if (uaMatch?.[1]) {
        return uaMatch[1];
    }
    const versionMatch = text.match(VERSION_REGEX);
    if (versionMatch?.[1]) {
        return versionMatch[1];
    }
    return null;
}

function parseVersionFromJson(value: unknown): string | null {
    if (typeof value === 'string') {
        return parseVersionFromText(value);
    }
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    const candidateKeys = ['version', 'currentVersion', 'latestVersion', 'release', 'tag'];
    for (const key of candidateKeys) {
        const candidate = record[key];
        if (typeof candidate === 'string') {
            const parsed = parseVersionFromText(candidate);
            if (parsed) {
                return parsed;
            }
        }
    }
    return null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchLatestVersionFromUrl(url: string): Promise<string | null> {
    try {
        const response = await fetchWithTimeout(url, VERSION_TIMEOUT_MS);
        if (!response.ok) {
            return null;
        }
        const headerVersion = response.headers.get('x-antigravity-version') || response.headers.get('x-version');
        if (headerVersion) {
            const parsed = parseVersionFromText(headerVersion);
            if (parsed) {
                return parsed;
            }
        }
        const text = await response.text();
        const parsedJson = (() => {
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        })();
        const jsonVersion = parseVersionFromJson(parsedJson);
        if (jsonVersion) {
            return jsonVersion;
        }
        return parseVersionFromText(text);
    } catch {
        return null;
    }
}

async function refreshAntigravityVersion(): Promise<void> {
    const versionUrls = getVersionUrls();
    if (versionUrls.length === 0) {
        return;
    }
    for (const url of versionUrls) {
        const version = await fetchLatestVersionFromUrl(url);
        if (version) {
            cachedVersion = version;
            lastFetchedAt = Date.now();
            return;
        }
    }
}

function buildPlatformTag(): string {
    const platform = (() => {
        switch (process.platform) {
            case 'win32':
                return 'windows';
            case 'darwin':
                return 'Darwin';
            case 'linux':
                return 'linux';
            default:
                return process.platform;
        }
    })();
    const arch = (() => {
        switch (process.arch) {
            case 'x64':
                return 'amd64';
            case 'arm64':
                return 'arm64';
            case 'ia32':
                return '386';
            default:
                return process.arch;
        }
    })();
    return `${platform}/${arch}`;
}

export function primeAntigravityUserAgent(): void {
    const now = Date.now();
    if (now - lastFetchedAt < VERSION_CACHE_TTL_MS) {
        return;
    }
    if (refreshInFlight) {
        return;
    }
    refreshInFlight = refreshAntigravityVersion()
        .catch(() => undefined)
        .finally(() => {
            refreshInFlight = null;
        });
}

export function getAntigravityUserAgent(): string {
    return `antigravity/${cachedVersion} ${buildPlatformTag()}`;
}
