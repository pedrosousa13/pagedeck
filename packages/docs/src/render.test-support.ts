import { createMarkdownRenderer } from "@pagedeck/markdown-loader";

// Every code-fence language the pages use; a page with another fails to render until it is here.
export const LANGUAGES = ["css", "html", "js", "json", "nginx", "sh", "toml", "ts", "tsx"] as const;

export const docsRenderer = (): ReturnType<typeof createMarkdownRenderer> =>
  createMarkdownRenderer({ languages: [...LANGUAGES] });
