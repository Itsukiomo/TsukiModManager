export function homeTrendingSlots<T>(mods: readonly T[]) {
  return {
    featured: [...mods.slice(0, 2), ...mods.slice(6)],
    secondary: mods.slice(2, 6),
  };
}
