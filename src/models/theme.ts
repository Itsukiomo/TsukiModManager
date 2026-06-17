export interface AppTheme {
  id: string;
  name: string;
  description: string;
  symbol: string;
}

export const APP_THEMES: AppTheme[] = [
  { id: "moonveil", name: "Moonveil", description: "Purple Tsuki default with blue glass.", symbol: "☾" },
  { id: "true-dark", name: "True Dark", description: "Near-black OLED mode with minimal glow.", symbol: "●" },
  { id: "polar-day", name: "Polar Day", description: "Fixed bright theme with readable cards everywhere.", symbol: "○" },
  { id: "neon-rift", name: "Neon Rift", description: "High-energy violet, pink, and cyan.", symbol: "◇" },
  { id: "aqua-ghost", name: "Aqua Ghost", description: "Cold aqua glass with teal accents.", symbol: "✦" },
  { id: "ember-forge", name: "Ember Forge", description: "Warm orange sparks over charcoal.", symbol: "◆" },
  { id: "sakura-night", name: "Sakura Night", description: "Soft rose and plum night colors.", symbol: "✿" },
  { id: "emerald-grid", name: "Emerald Grid", description: "Green terminal glow without harsh contrast.", symbol: "▣" },
  { id: "royal-indigo", name: "Royal Indigo", description: "Clean indigo panels with gold accents.", symbol: "◈" },
  { id: "basic-light", name: "Classic Light", description: "Legacy light option, repaired for old saves.", symbol: "◌" },
];
