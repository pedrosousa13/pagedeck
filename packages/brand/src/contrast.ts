export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(colour: string): number {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (match === null) {
    throw new Error(
      `Colour "${colour}": is not a hex colour this check can read — write brand colour tokens as #rrggbb or #rgb`,
    );
  }
  const hex = (match[1] as string).replace(
    /^(.)(.)(.)$/,
    "$1$1$2$2$3$3",
  );
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
