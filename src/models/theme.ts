export interface AppTheme {
  id: string;
  name: string;
  description: string;
  mode: "dark" | "light";
  preview: [string, string, string];
}

export const APP_THEMES: AppTheme[] = [
  { id: "moonveil", name: "Moonveil", description: "Balanced violet Tsuki default.", mode: "dark", preview: ["#030616", "#9b72ff", "#39d6ff"] },
  { id: "true-dark", name: "True Dark", description: "Near-black OLED surfaces.", mode: "dark", preview: ["#000000", "#8b8bff", "#f8f8f8"] },
  { id: "polar-day", name: "Polar Day", description: "Bright blue-white workspace.", mode: "light", preview: ["#eef4ff", "#3d5cff", "#0f93b8"] },
  { id: "neon-rift", name: "Neon Rift", description: "Violet, pink, and cyan contrast.", mode: "dark", preview: ["#070013", "#ff4fd8", "#28e7ff"] },
  { id: "aqua-ghost", name: "Aqua Ghost", description: "Cool aqua glass.", mode: "dark", preview: ["#03131d", "#30e4d1", "#67a6ff"] },
  { id: "ember-forge", name: "Ember Forge", description: "Warm charcoal and amber.", mode: "dark", preview: ["#120806", "#ff914d", "#ffd166"] },
  { id: "sakura-night", name: "Sakura Night", description: "Soft rose night palette.", mode: "dark", preview: ["#130712", "#ff83bd", "#c48cff"] },
  { id: "emerald-grid", name: "Emerald Grid", description: "Green terminal glow.", mode: "dark", preview: ["#020e0a", "#48f59a", "#35d6ff"] },
  { id: "royal-indigo", name: "Royal Indigo", description: "Indigo with gold accents.", mode: "dark", preview: ["#07091d", "#8b8cff", "#ffd76a"] },
  { id: "classic-light", name: "Classic Light", description: "Readable legacy light theme.", mode: "light", preview: ["#f8fbff", "#5865ff", "#9b4dff"] },
];

export const APP_THEME_IDS = APP_THEMES.map((theme) => theme.id);
