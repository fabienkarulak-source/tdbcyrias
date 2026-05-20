// assets/components.js

const sidebarHTML = `
  <nav class="sidebar">
    <div class="sidebar-header" style="padding: 24px; border-bottom: 1px solid var(--divider);">
      <h2 style="font-weight: 800; color: var(--primary);">CYRIAS Buddy</h2>
    </div>
    <div class="sidebar-nav" style="padding: 16px; display: flex; flex-direction: column; gap: 8px;">
      <a href="index.html" class="nav-item">🏠 Accueil</a>
      
      <div style="font-size: 11px; font-weight: bold; color: var(--ink-muted); margin-top: 12px; text-transform: uppercase;">Pilotage & Data</div>
      <a href="craminator.html" class="nav-item">📊 CRAminator & Facturator</a>
      
      <div style="font-size: 11px; font-weight: bold; color: var(--ink-muted); margin-top: 12px; text-transform: uppercase;">Quotidien</div>
      <a href="organisator.html" class="nav-item">📅 Organisator & Kanban</a>
      
      <div style="font-size: 11px; font-weight: bold; color: var(--ink-muted); margin-top: 12px; text-transform: uppercase;">Technique</div>
      <a href="tech-tools.html" class="nav-item">⚡ SQL, Logs & Snippets</a>
    </div>
  </nav>
`;

// Fonction pour injecter la sidebar et mettre en surbrillance la page active
function initLayout() {
    // Injecter la sidebar
    const container = document.getElementById('sidebar-container');
    if (container) {
        container.innerHTML = sidebarHTML;
    }

    // Mettre la classe "active" sur le bon lien selon l'URL
    const currentPath = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.sidebar-nav a').forEach(link => {
        if (link.getAttribute('href') === currentPath) {
            link.style.backgroundColor = 'var(--brand-soft)';
            link.style.color = 'var(--brand-hover)';
            link.style.fontWeight = '700';
            link.style.borderLeft = '3px solid var(--brand)';
        } else {
            link.style.color = 'var(--ink-secondary)';
            link.style.textDecoration = 'none';
            link.style.padding = '8px 12px';
            link.style.display = 'block';
        }
    });
}

// Exécuter quand le DOM est prêt
document.addEventListener('DOMContentLoaded', initLayout);
