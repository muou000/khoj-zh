/**
 * Khoj Obsidian Plugin i18n Module
 *
 * Provides internationalization support with language detection
 * and translation functions.
 */

import { getLocale } from 'obsidian';

// Import translations
import { zhCN } from './locales/zh-CN';

/**
 * Supported language codes
 */
export type LanguageCode = 'en' | 'zh-CN' | 'zh';

/**
 * Translation dictionary type
 */
export type TranslationDict = {
    [key: string]: string | TranslationDict;
};

/**
 * Available translations
 */
export const translations: Record<LanguageCode, TranslationDict> = {
    'en': {}, // English uses keys as fallback
    'zh-CN': zhCN,
    'zh': zhCN, // Alias for zh-CN
};

/**
 * Current language code
 */
let currentLanguage: LanguageCode = 'en';

/**
 * Initialize the i18n system by detecting the user's language
 */
export function initI18n(): void {
    const locale = getLocale();

    // Map Obsidian locale to our supported languages
    if (locale.startsWith('zh-CN') || locale.startsWith('zh-Hans')) {
        currentLanguage = 'zh-CN';
    } else if (locale.startsWith('zh')) {
        currentLanguage = 'zh';
    } else {
        currentLanguage = 'en';
    }

    console.log(`Khoj: i18n initialized with language: ${currentLanguage}`);
}

/**
 * Get the current language code
 */
export function getCurrentLanguage(): LanguageCode {
    return currentLanguage;
}

/**
 * Set the language manually (for testing or future settings)
 */
export function setLanguage(lang: LanguageCode): void {
    if (translations[lang]) {
        currentLanguage = lang;
        console.log(`Khoj: Language set to: ${lang}`);
    }
}

/**
 * Get translation for a key
 *
 * @param key - The translation key (dot-separated path)
 * @param lang - Optional language override
 * @returns The translated string or the key if not found
 */
export function t(key: string, lang?: LanguageCode): string {
    const language = lang || currentLanguage;

    // Always use English (key) as fallback
    if (language === 'en') {
        return key;
    }

    const langTranslations = translations[language];
    if (!langTranslations) {
        return key;
    }

    // Navigate through nested keys
    const keys = key.split('.');
    let value: string | TranslationDict = langTranslations;

    for (const k of keys) {
        if (typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            // Key not found, return the original key as fallback
            return key;
        }
    }

    return typeof value === 'string' ? value : key;
}

/**
 * Check if a translation key exists
 */
export function hasTranslation(key: string, lang?: LanguageCode): boolean {
    const language = lang || currentLanguage;
    const langTranslations = translations[language];

    if (!langTranslations) {
        return false;
    }

    const keys = key.split('.');
    let value: string | TranslationDict = langTranslations;

    for (const k of keys) {
        if (typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return false;
        }
    }

    return typeof value === 'string';
}

/**
 * Get all available languages
 */
export function getAvailableLanguages(): { code: LanguageCode; name: string }[] {
    return [
        { code: 'en', name: 'English' },
        { code: 'zh-CN', name: '简体中文' },
    ];
}

// Auto-initialize on module load
initI18n();
