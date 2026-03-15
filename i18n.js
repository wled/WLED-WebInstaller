// i18n.js - Internationalization for WLED Web Installer

const I18N_LANG_STORAGE_KEY = 'wled-webinstaller:language';

// Available languages (loaded from languages.json)
let AVAILABLE_LANGUAGES = {};

// Translation messages cache
let i18n_messages = {};

// Load available languages from languages.json
async function loadAvailableLanguages() {
    try {
        const response = await fetch('locales/languages.json');
        if (!response.ok) throw new Error('Failed to load languages.json');
        AVAILABLE_LANGUAGES = await response.json();
    } catch (error) {
        console.error('Error loading languages.json:', error);
        // Fallback to default English
        AVAILABLE_LANGUAGES = {
            'en': { code: 'en', name: 'English', nativeName: 'English' }
        };
    }
}

// Load language file
async function loadLanguage(lang) {
    if (!i18n_messages[lang]) {
        try {
            const response = await fetch(`locales/${lang}.json`);
            if (!response.ok) throw new Error(`Failed to load language: ${lang}`);
            i18n_messages[lang] = await response.json();
        } catch (error) {
            console.error(`Error loading language ${lang}:`, error);
            // Fallback to English if loading fails
            if (lang !== 'en') {
                return loadLanguage('en');
            }
        }
    }
    return i18n_messages[lang];
}

// Populate language selector dropdown with available languages
function populateLanguageSelector() {
    const languageSelect = document.getElementById('languageSelect');
    languageSelect.innerHTML = ''; // Clear existing options
    
    for (const [code, langInfo] of Object.entries(AVAILABLE_LANGUAGES)) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = langInfo.nativeName || langInfo.name;
        languageSelect.appendChild(option);
    }
}

// Function to update text content based on selected language
async function i18n() {
    const lang = document.getElementById('languageSelect').value;
    document.documentElement.lang = lang; // Set the lang attribute of the HTML document
    
    // Load the language file if not already loaded
    await loadLanguage(lang);
    
    // Always ensure English is loaded as fallback
    if (!i18n_messages['en']) {
        await loadLanguage('en');
    }
    
    const messages = i18n_messages[lang] || i18n_messages['en']; // Fallback to English if language not found

    document.querySelectorAll('[data-i18n]').forEach((elem) => {
        const key = elem.getAttribute('data-i18n');
        const translation = messages[key] ?? (i18n_messages['en'] ? i18n_messages['en'][key] : key); // Fallback to English if key not found
        elem.textContent = translation;
        
        // console.log(`i18n: ${messages[key] || i18n_messages['en'][key]} | ${key} => ${translation}`);
    });
}

// Initialize i18n on page load
async function i18nInit() {
    // Load available languages first
    await loadAvailableLanguages();
    
    // Get saved language from localStorage
    let savedLang = localStorage.getItem(I18N_LANG_STORAGE_KEY);

    // If no saved language or not in the list of available languages, set default to English
    if (!savedLang || !AVAILABLE_LANGUAGES[savedLang]) {
        savedLang = 'en';
        localStorage.setItem(I18N_LANG_STORAGE_KEY, savedLang);
    }

    // Populate language selector
    populateLanguageSelector();

    // Set the select element to the saved language
    document.getElementById('languageSelect').value = savedLang;

    // Apply translations
    await i18n();
}

// Event for language selection change
async function changeLanguage() {
    const selectedLang = document.getElementById('languageSelect').value;
    localStorage.setItem(I18N_LANG_STORAGE_KEY, selectedLang);
    await i18n();
}
