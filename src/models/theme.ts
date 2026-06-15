export interface AppTheme {
  id: string;
  name: string;
  description: string;
  symbol: string;
}

export const APP_THEMES: AppTheme[] = [
  {
    id: "moonveil",
    name: "Moonveil",
    description: "Default deep purple night mode.",
    symbol: "☾",
  },
  {
    id: "neon-rift",
    name: "Neon Rift",
    description: "Purple and blue cyber glow.",
    symbol: "◇",
  },
  {
    id: "aqua-ghost",
    name: "Aqua Ghost",
    description: "Cool blue-green glass theme.",
    symbol: "✦",
  },
  {
    id: "basic-dark",
    name: "Basic Dark",
    description: "Simple dark mode with less glow.",
    symbol: "●",
  },
  {
    id: "basic-light",
    name: "Basic Light",
    description: "Clean light mode for daytime.",
    symbol: "○",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Nearly black with soft blue.",
    symbol: "◐",
  },
  {
    id: "crimson-noir",
    name: "Crimson Noir",
    description: "Red-black midnight shell.",
    symbol: "◆",
  },
  {
    id: "solar-byte",
    name: "Solar Byte",
    description: "Warm amber terminal glow.",
    symbol: "◌",
  },
];
