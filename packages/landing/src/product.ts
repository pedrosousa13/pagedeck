// Generated with no clock or random source, so two builds serialize it alike.

const COLOURS = [
  ["Slate", "SLT"],
  ["Storm Grey", "STG"],
  ["Moss", "MOS"],
  ["Ember", "EMB"],
  ["Glacier Blue", "GLB"],
  ["Black", "BLK"],
] as const;

const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL"] as const;

const WAREHOUSES = ["north-2", "south-1", "east-4"] as const;

function day(days: number): string {
  return new Date(Date.UTC(2026, 2, 3 + days, 9, (days * 7) % 60)).toISOString();
}

function barcode(n: number): string {
  const body = `40${String(7_310_000_000 + n * 7919).padStart(10, "0")}`;
  const sum = [...body].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${body}${String((10 - (sum % 10)) % 10)}`;
}

function variants() {
  return COLOURS.flatMap(([colour, code], c) =>
    SIZES.map((size, s) => {
      const n = c * SIZES.length + s;
      const file = `${colour.toLowerCase().replace(/\s+/g, "-")}-${size.toLowerCase()}`;
      return {
        id: `RSH-24-${code}-${size}`,
        colour,
        size,
        title: `Ridgeline Shell, ${colour}, size ${size}`,
        barcode: barcode(n),
        supplierReference: `KL-2208-${code}${String(s + 1).padStart(2, "0")}`,
        costPrice: { amount: 6120 + s * 85, currency: "USD" },
        weightGrams: 355 + s * 14,
        measurements: {
          chestCm: 94 + s * 6,
          backLengthCm: 72 + s * 2,
          sleeveCm: 82 + s * 1.5,
        },
        stock: WAREHOUSES.map((warehouse, w) => ({
          warehouse,
          onHand: (n * 13 + w * 29) % 57,
          reserved: (n * 5 + w * 3) % 7,
          bin: `${String.fromCharCode(65 + w)}-${String(10 + c).padStart(2, "0")}-${String(s + 1).padStart(2, "0")}`,
          reorderPoint: 8 + w * 2,
        })),
        media: ["front", "back", "detail"].map((view, v) => ({
          src: `/media/rsh-24/${file}-${view}.jpg`,
          alt: `Ridgeline Shell in ${colour}, size ${size}, ${view} view`,
          width: 2000,
          height: 2500,
          focalPoint: { x: 0.5, y: 0.35 + v * 0.1 },
        })),
        status: n % 11 === 10 ? "backorder" : "active",
      };
    }),
  );
}

const REVIEWERS = [
  "Priya S.", "Tomasz W.", "Aiko M.", "Daniel R.", "Grace O.", "Mateo L.",
  "Hannah K.", "Yusuf A.", "Ingrid B.", "Kofi D.", "Lena F.", "Rafael C.",
] as const;
const PLACES = [
  "Bergen", "Portland", "Kraków", "Sapporo", "Galway", "Valparaíso",
  "Tasmania", "Ljubljana",
] as const;
const TITLES = [
  "Dry after a full day on the ridge",
  "Packs down smaller than I expected",
  "Runs a little long in the sleeves",
  "The hood actually stays put",
  "Good shell, noisy fabric",
  "My third season with it",
  "Worth it for the pit zips alone",
  "Fits over a thick fleece",
] as const;
const OPENINGS = [
  "I wore this through four days of sideways rain on the coast path.",
  "Bought it for a trip to the fells and it has not left my pack since.",
  "I commute by bike every day, whatever the sky is doing.",
  "Took it up a wet scramble last weekend to see what it could take.",
  "I run cold, so I sized up to get a fleece underneath.",
  "My old shell wetted out on the shoulders under a rucksack.",
] as const;
const MIDDLES = [
  "The seams held and the cuffs sealed properly around gloves.",
  "Breathability is fine on the climbs if you open the vents early.",
  "The chest pocket fits a phone and a map, just about.",
  "The brim on the hood keeps rain off glasses better than most.",
  "It does rustle when you walk, which bothers some people more than others.",
  "After a wash and a tumble the water still beads straight off.",
] as const;
const CLOSINGS = [
  "I would buy it again.",
  "Not cheap, but I expect it to last years.",
  "Size down if you are between sizes.",
  "Wish it came in a brighter colour for winter.",
  "The best shell I have owned so far.",
  "Four stars only because of the noise.",
] as const;

function pick<T>(pool: readonly T[], index: number): T {
  return pool[index % pool.length] as T;
}

function reviews(ids: readonly string[]) {
  return Array.from({ length: 32 }, (_, n) => {
    const rating = [5, 4, 5, 3, 4, 5, 2, 4][n % 8] as number;
    return {
      id: `rev_${String(4100 + n * 17)}`,
      rating,
      title: pick(TITLES, n * 3),
      body: `${pick(OPENINGS, n)} ${pick(MIDDLES, n * 5 + 1)} ${pick(CLOSINGS, n * 7 + 2)}`,
      author: {
        displayName: pick(REVIEWERS, n * 5),
        location: pick(PLACES, n * 3 + 1),
        verifiedBuyer: n % 5 !== 3,
      },
      variantId: pick(ids, n * 11),
      submittedAt: day(20 + n * 3),
      helpfulVotes: (n * 7) % 23,
      moderation: {
        status: "approved",
        reviewedAt: day(21 + n * 3),
        queue: n % 4 === 0 ? "flagged-language" : "standard",
        note:
          n % 4 === 0
            ? `Queue review ${String(n)}: flagged for one word, approved unchanged after a second read.`
            : `Queue review ${String(n)}: passed the automatic checks.`,
      },
    };
  });
}

function product() {
  const variantList = variants();
  return {
    id: "prd_0b7e41c9",
    contentType: "product",
    locale: "en",
    slug: "ridgeline-shell",
    sku: "RSH-24",
    name: "Ridgeline Shell",
    tagline: "A three-layer rain jacket for long wet days",
    price: { amount: 18900, currency: "USD" },
    description: [
      {
        type: "paragraph",
        children: [
          { text: "The Ridgeline Shell is a three-layer waterproof jacket cut for " },
          { text: "moving uphill in bad weather", marks: ["bold"] },
          { text: ", with room underneath for a warm layer and nothing that flaps." },
        ],
      },
      {
        type: "paragraph",
        children: [
          { text: "Taped seams, a stiffened hood brim and two-way underarm zips " },
          { text: "let heat out without letting the rain in." },
        ],
      },
      {
        type: "paragraph",
        children: [
          { text: "It packs into its own chest pocket, " },
          { text: "about the size of a water bottle", marks: ["bold"] },
          { text: ", and clips to a harness loop." },
        ],
      },
    ],
    specs: [
      { label: "Waterproofing", value: "20,000 mm hydrostatic head" },
      { label: "Breathability", value: "25,000 g/m²/24 h" },
      { label: "Face fabric", value: "Recycled nylon ripstop, 40 denier" },
      { label: "Weight", value: "From 355 g, size XS" },
      { label: "Packed size", value: "18 × 9 cm" },
      { label: "Fit", value: "Regular, room for a midlayer" },
    ],
    variants: variantList,
    reviews: reviews(variantList.map((variant) => variant.id)),
    careInstructions: [
      "Machine wash cold on a synthetic cycle with a technical cleaner.",
      "Do not use fabric softener, which clogs the membrane.",
      "Tumble dry low for twenty minutes to reactivate the water repellency.",
      "Do not dry clean or iron over the seam tape.",
    ],
    materials: [
      { part: "face fabric", composition: "100% recycled polyamide", origin: "woven in Taiwan" },
      { part: "membrane", composition: "expanded polyurethane, PFC-free", origin: "laminated in Taiwan" },
      { part: "backer", composition: "100% polyester tricot knit", origin: "knitted in Vietnam" },
    ],
    related: [
      { id: "prd_1c2f9a70", sku: "RPT-22", name: "Ridgeline Rain Trousers", reason: "complete-the-set" },
      { id: "prd_4ad0e3b2", sku: "TFH-23", name: "Tarn Fleece Hoodie", reason: "layer-underneath" },
      { id: "prd_7e91c0d4", sku: "CGL-21", name: "Crag Softshell Gloves", reason: "frequently-bought" },
      { id: "prd_93b5f1a8", sku: "BWP-24", name: "Bothy Waterproof Pack Liner", reason: "frequently-bought" },
    ],
    seo: {
      title: "Ridgeline Shell waterproof jacket, three-layer, packable",
      description:
        "A packable three-layer rain jacket with taped seams, underarm vents and a hood that stays put. Six colours, sizes XS to 3XL.",
      keywords: [
        "waterproof shell jacket",
        "three-layer shell",
        "packable rain jacket",
        "hiking rain shell",
        "PFC-free waterproof",
      ],
      canonicalPath: "/products/ridgeline-shell",
      openGraphImage: "/media/rsh-24/slate-m-front.jpg",
    },
    editorial: {
      internalNotes:
        "SENTINEL-internal-notes-7c1e: margin target is 62% after the spring price change; do not mention the supplier switch until the trousers restock.",
      owner: "outerwear-merchandising",
      stage: "approved",
      history: Array.from({ length: 10 }, (_, n) => ({
        at: day(n * 2),
        by: pick(["copy-desk", "outerwear-merchandising", "photo-studio", "legal-review"], n),
        action: pick(["drafted", "edited", "requested-changes", "approved"], n * 3),
        comment: pick(
          [
            "First pass on the description, specs pending from the lab.",
            "Tightened the lede and added the packed-size figure.",
            "Hydrostatic head claim needs the lab certificate attached.",
            "Swapped hero shots to the Moss colourway for the spring campaign.",
            "Certificate attached, claim approved as written.",
          ],
          n,
        ),
      })),
    },
    createdAt: day(0),
    updatedAt: day(19),
  };
}

export const PRODUCT = product();

export type ProductEntry = typeof PRODUCT;
