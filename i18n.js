// i18n.js - Internationalization for WLED Web Installer
//
// Languages live in lang/: one lang/<code>.json file per language, plus
// lang/languages.json (a { code: "display name" } map of what's available).
// To add a language, drop lang/<code>.json with the same keys as
// lang/en.json, then add one line to lang/languages.json - the language
// selector and translations pick it up automatically, no other changes.

const I18N_LANG_STORAGE_KEY = 'wled-webinstaller:language';
const I18N_FALLBACK_LANG = 'en';

let i18n_languages = {};   // code -> display name, from lang/languages.json
let i18n_messages = {};    // code -> { key: text }, fetched on demand
let i18n_currentLang = I18N_FALLBACK_LANG;

/** Read a localStorage key, returning null if storage is unavailable (private mode, blocked, etc). */
function i18n_safeGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

/** Write a localStorage key, silently ignoring failures if storage is unavailable. */
function i18n_safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Ignore - language selection just won't persist across reloads.
  }
}

/** Fetch and parse JSON, throwing on non-2xx responses. */
function i18n_fetchJson(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
    return res.json();
  });
}

/** Load translation messages for one language, with in-memory caching. */
function i18n_loadMessages(lang) {
  if (i18n_messages[lang]) return Promise.resolve(i18n_messages[lang]);
  return i18n_fetchJson('lang/' + lang + '.json').then(function (messages) {
    i18n_messages[lang] = messages;
    return messages;
  });
}

/** Apply the current language messages to all elements with data-i18n keys. */
function i18n_apply() {
  const fallback = i18n_messages[I18N_FALLBACK_LANG] || {};
  const messages = i18n_messages[i18n_currentLang] || {};

  document.documentElement.lang = i18n_currentLang;
  document.querySelectorAll('[data-i18n]').forEach((elem) => {
    const key = elem.getAttribute('data-i18n');
    const text = messages[key] ?? fallback[key];
    if (text !== undefined) elem.textContent = text;
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((elem) => {
    const key = elem.getAttribute('data-i18n-aria-label');
    const text = messages[key] ?? fallback[key];
    if (text !== undefined) elem.setAttribute('aria-label', text);
  });
}

// Loads the current language (plus the English fallback, so missing keys
// still render something) and applies it to the page.
/**
 * Load and apply translations for the requested language.
 * Falls back to English if loading fails.
 */
function i18n(lang) {
  if (lang) i18n_currentLang = lang;
  const needed = [I18N_FALLBACK_LANG];
  if (i18n_currentLang !== I18N_FALLBACK_LANG) needed.push(i18n_currentLang);

  return Promise.all(needed.map(i18n_loadMessages))
    .then(i18n_apply)
    .catch((err) => {
      console.warn('i18n: failed to load language "' + i18n_currentLang + '", falling back to English.', err);
      if (i18n_currentLang === I18N_FALLBACK_LANG) return;
      i18n_currentLang = I18N_FALLBACK_LANG;
      return i18n_loadMessages(I18N_FALLBACK_LANG).then(i18n_apply);
    });
}

/** Populate the language <select> with available options. */
function i18n_populateLanguageSelect() {
  const select = document.getElementById('languageSelect');
  select.innerHTML = '';
  Object.keys(i18n_languages).forEach((code) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = i18n_languages[code];
    select.appendChild(opt);
  });
  select.value = i18n_currentLang;
}

/** Persist the selected language and refresh rendered translations. */
function changeLanguage() {
  const selectedLang = document.getElementById('languageSelect').value;
  i18n_safeSetItem(I18N_LANG_STORAGE_KEY, selectedLang);
  i18n(selectedLang);
}

/** Initialize i18n language metadata, selector wiring, and first render. */
function i18nInit() {
  i18n_currentLang = i18n_safeGetItem(I18N_LANG_STORAGE_KEY) || I18N_FALLBACK_LANG;

  i18n_fetchJson('lang/languages.json')
    .catch((err) => {
      console.warn('i18n: failed to load lang/languages.json, falling back to English only.', err);
      return { en: 'English' };
    })
    .then((languages) => {
      i18n_languages = languages;
      if (!i18n_languages[i18n_currentLang]) i18n_currentLang = I18N_FALLBACK_LANG;
      i18n_safeSetItem(I18N_LANG_STORAGE_KEY, i18n_currentLang);

      i18n_populateLanguageSelect();
      document.getElementById('languageSelect').addEventListener('change', changeLanguage);

      return i18n(i18n_currentLang);
    });
}
