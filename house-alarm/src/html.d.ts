// Wrangler bundles .html files as text (see "rules" in wrangler.jsonc).
declare module "*.html" {
  const text: string;
  export default text;
}
