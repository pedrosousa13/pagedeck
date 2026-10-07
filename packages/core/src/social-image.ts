import type { ContentStoreReader } from "@pagedeck/content";
import type { Page } from "./pages.js";
import { quote } from "./quote.js";

export type SocialImageInputs = Readonly<Record<string, unknown>>;

export interface SocialImageRequest {
  readonly page: Page;
  readonly title: string | undefined;
  readonly inputs: SocialImageInputs;
}

export interface SocialImageResult {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface SocialImageAdapter {
  readonly name: string;
  draw(
    request: SocialImageRequest,
  ): SocialImageResult | Promise<SocialImageResult>;
}

export interface SocialImagesSetting {
  readonly adapter: SocialImageAdapter;
  inputs(
    page: Page,
    store: ContentStoreReader,
  ):
    | SocialImageInputs
    | undefined
    | Promise<SocialImageInputs | undefined>;
}

const SECTION_SHAPE_FIX =
  'socialImages: { adapter: { name: "acme-cards", draw: (request) => ({ bytes, width, height }) }, inputs: (page, store) => ({ title: "Pricing" }) }';
const ADAPTER_NAME_FIX =
  'write the name this adapter is reported by, such as "acme-cards"';
const ADAPTER_DRAW_FIX =
  "write the function this build hands one page, its title and the site's inputs to, as draw: (request) => ({ bytes, width, height })";
const INPUTS_FIX =
  "write the callback this build asks per page, as inputs: (page, store) => ({ … }) — return undefined for a page that gets no card";

function adapterFaults(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [
      `  "adapter" — ${quote(value)} — not an object — ${SECTION_SHAPE_FIX}`,
    ];
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const faults: string[] = [];
  const name = read("name");
  if (typeof name !== "string" || name.trim() === "") {
    faults.push(
      `  "adapter.name" — ${quote(name)} — not an adapter name — ${ADAPTER_NAME_FIX}`,
    );
  }
  if (typeof read("draw") !== "function") {
    faults.push(
      `  "adapter.draw" — ${quote(read("draw"))} — not a draw function — ${ADAPTER_DRAW_FIX}`,
    );
  }
  return faults;
}

export function socialImagesFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.socialImages" must be an object with an adapter and an inputs callback — ${SECTION_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const sections: string[] = [];

  const adapterIssues = adapterFaults(read("adapter"));
  if (adapterIssues.length > 0) {
    sections.push(
      `${where}: "build.socialImages.adapter" declares ${
        adapterIssues.length === 1
          ? "1 field this build cannot draw through"
          : `${String(adapterIssues.length)} fields this build cannot draw through`
      } — declare each as the type its own line names:\n${adapterIssues.join("\n")}`,
    );
  }

  if (typeof read("inputs") !== "function") {
    sections.push(
      `${where}: "build.socialImages.inputs" — ${quote(read("inputs"))} — not a function — ${INPUTS_FIX}`,
    );
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}
