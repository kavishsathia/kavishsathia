declare module "codemirror-lang-verilog" {
  import type { LanguageSupport } from "@codemirror/language";

  export function verilog(config?: { completion?: boolean }): LanguageSupport;
}
