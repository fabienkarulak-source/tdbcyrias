// assets/app.js

// --- 1. Gestion sécurisée du LocalStorage ---
const SafeStorage = {
    get: function(key) { 
        try { const i = localStorage.getItem(key); return i ? JSON.parse(i) : null; } 
        catch(e) { return null; } 
    },
    set: function(key, value) { 
        try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) { console.error("Erreur Storage", e); } 
    },
    remove: function(key) { 
        try { localStorage.removeItem(key); } catch(e) {} 
    }
};

// --- 2. Utilitaires UI ---
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- 3. Initialisation Commune ---
window.addEventListener('load', () => {
    // Appliquer le thème s'il existe
    const theme = localStorage.getItem('cyrias_theme');
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
});
