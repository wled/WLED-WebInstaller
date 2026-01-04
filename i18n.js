// i18n.js - Internationalization for WLED Web Installer

// Translation messages
const i18n_messages = {
    "en": {
        "maintenance1": "Web Installer under maintenance",
        "maintenance2": "The WLED web installer is currently out of service due to maintenance work and will be back online shortly.",
        "maintenance3": "In the meantime, you can use the webinstaller provided by Wladi: ",
        "welcome": "Welcome to the WLED web installer!",
        "unsupported1": "Sorry, your browser is not yet supported!",
        "unsupported2": "Please try on Desktop Chrome or Edge.",
        "unsupported3": "Find binary files here:",
        "step1-1": "Plug in your ESP to a USB port. We will install WLED ",
        "step1-2": " to it.",
        "step2": "Hit \"Install\" and select the correct COM port.",
        "noDeviceFound": "No device found?",
        "serialHelp1": "You might be missing the drivers for your board.",
        "serialHelp2": "Here are drivers for chips commonly used in ESP boards:",
        "serialHelp3": "Make sure your USB cable supports data transfer.",
        "chip1": "CP2102 (square chip)",
        "chip2": "CH34x (rectangular chip)",
        "step3": "Get WLED installed and connected in less than 3 minutes!",
        "install": "Install",
        "powered1": "Powered by ",
        "powered2": " ",
        "cors1": "CORS proxy by ",
        "cors2": " "
    },
    "zh-CN": {
        "maintenance1": "网络安装程序正在维护中",
        "maintenance2": "由于维护工作，WLED 网络安装程序目前无法使用，但它将很快重新上线。",
        "maintenance3": "在此期间，您可以使用 Wladi 提供的网络安装程序：",
        "welcome": "欢迎使用 WLED 网络安装程序！",
        "unsupported1": "抱歉，尚不支持您使用的浏览器！",
        "unsupported2": "请在桌面版 Chrome 或 Edge 上尝试。",
        "unsupported3": "在此处查找二进制文件：",
        "step1-1": "将您的 ESP 插入 USB 端口。我们将向其安装 WLED ",
        "step1-2": " 。",
        "step2": "点击“安装”并选择正确的 COM 端口。",
        "noDeviceFound": "未找到设备？",
        "serialHelp1": "您可能缺少开发板的驱动程序。",
        "serialHelp2": "以下是 ESP 开发板常用的芯片驱动程序：",
        "serialHelp3": "确保您的 USB 数据线支持数据传输。",
        "chip1": "CP2102（正方形芯片）",
        "chip2": "CH34x（长方形芯片）",
        "step3": "在不到 3 分钟的时间内安装并连接 WLED！",
        "install": "安装",
        "powered1": " ",
        "powered2": " 强力驱动",
        "cors1": "CORS 代理由 ",
        "cors2": " 提供支持"
    }
};


// Function to update text content based on selected language
function i18n() {
    const lang = document.getElementById('languageSelect').value;
    const messages = i18n_messages[lang] || i18n_messages['en']; // Fallback to English

    document.querySelectorAll('[data-i18n]').forEach(function (elem) {
        const key = elem.getAttribute('data-i18n');
        const translation = messages[key] || (i18n_messages['en'] && i18n_messages['en'][key]);
        if (translation) {
            elem.textContent = translation;
        }
    });
}


// Initialize i18n on page load
function i18nInit() {
    // Get saved language from localStorage
    let savedLang = localStorage.getItem('Language');

    // If no saved language or not in the list of supported languages, set default to English
    if (!savedLang || !i18n_messages[savedLang]) {
        savedLang = 'en';
        localStorage.setItem('Language', savedLang);
    }

    // Set the select element to the saved language
    document.getElementById('languageSelect').value = savedLang;

    // Apply translations
    i18n();
}


// Event for language selection change
function changeLanguage() {
    let selectedLang = document.getElementById('languageSelect').value;
    localStorage.setItem('Language', selectedLang);
    i18n();
}