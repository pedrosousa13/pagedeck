export const EDGE_TARGETS = [
  "cloudfront-function",
  "netlify",
  "nginx",
  "cloudflare-worker",
] as const;

export type EdgeTarget = (typeof EDGE_TARGETS)[number];
