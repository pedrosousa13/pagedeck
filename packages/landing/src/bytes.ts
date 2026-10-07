export function formatBytes(count: number): string {
  return count < 1000 ? `${String(count)} B` : `${(count / 1000).toFixed(1)} kB`;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const SPELLING = /^(?:(\d+) B|(\d+\.\d) kB)$/;

export function isSpelled(figure: string): boolean {
  return SPELLING.test(figure);
}

export function parseBytes(figure: string): number {
  const match = SPELLING.exec(figure);
  if (match === null) {
    throw new Error(
      `Byte figure "${figure}" is not in the site's spelling — write whole bytes below 1,000 ("307 B") or SI kilobytes to one decimal ("3.1 kB")`,
    );
  }
  return match[1] !== undefined ? Number(match[1]) : Math.round(Number(match[2]) * 1000);
}
