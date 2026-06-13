(function initTheme() {
  const STORAGE_KEY = "editpro-theme";

  function getPreferredTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch {
      // ignore
    }
    return "light";
  }

  function sunIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
  }

  function moonIcon() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>`;
  }

  function applyTheme(theme) {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(theme);
    document.documentElement.dataset.theme = theme;

    const logo = document.getElementById("railLogo");
    if (logo) {
      logo.src = theme === "dark" ? "editpro-logo-dark.png" : "editpro-logo-light.png";
    }

    const toggle = document.getElementById("sidebarThemeToggle");
    const icon = toggle?.querySelector(".rail-theme-icon");
    const label = document.getElementById("railThemeLabel");
    if (toggle) {
      const isDark = theme === "dark";
      toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
      toggle.setAttribute("title", isDark ? "Light mode" : "Dark mode");
      if (icon) {
        icon.innerHTML = isDark ? sunIcon() : moonIcon();
      }
      if (label) {
        label.textContent = isDark ? "Light mode" : "Dark mode";
      }
    }
  }

  function toggleTheme() {
    const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    applyTheme(next);
  }

  function init() {
    applyTheme(getPreferredTheme());
    document.getElementById("sidebarThemeToggle")?.addEventListener("click", toggleTheme);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
