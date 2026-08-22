// Appearance: "system" (default) | "dark" | "light", stored locally. The CSS light block keys
// off data-theme="light" or the .system-light class (set when the OS is light).
export function applyTheme(choice: string) {
  const root = document.documentElement;
  const systemLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = choice === "dark" || choice === "light" ? choice : "";
  root.classList.toggle("system-light", choice === "system" && systemLight);
}

export function currentTheme(): string {
  return localStorage.getItem("sm-theme") ?? "system";
}

export function setTheme(choice: string) {
  localStorage.setItem("sm-theme", choice);
  applyTheme(choice);
}

export function initTheme() {
  applyTheme(currentTheme());
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(currentTheme()));
}
