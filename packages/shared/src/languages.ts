/**
 * Language registry. New languages are added by registering a descriptor;
 * nothing in the pipeline hard-codes the initial three languages.
 */
export interface LanguageDescriptor {
  /** BCP-47 tag, e.g. "en-US", "ur-PK", "zh-CN". */
  tag: string;
  /** ISO 639-1 base code. */
  code: string;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
  /** Unicode script used for heuristic detection. */
  script: 'Latn' | 'Arab' | 'Hans' | 'Hant' | 'Deva' | 'Cyrl' | 'Other';
  /** Whether it ships enabled by default. */
  builtIn: boolean;
}

export const INITIAL_LANGUAGES: LanguageDescriptor[] = [
  { tag: 'en-US', code: 'en', name: 'English', nativeName: 'English', direction: 'ltr', script: 'Latn', builtIn: true },
  { tag: 'ur-PK', code: 'ur', name: 'Urdu', nativeName: 'اردو', direction: 'rtl', script: 'Arab', builtIn: true },
  { tag: 'zh-CN', code: 'zh', name: 'Mandarin Chinese', nativeName: '普通话', direction: 'ltr', script: 'Hans', builtIn: true },
];

export class LanguageRegistry {
  private readonly langs = new Map<string, LanguageDescriptor>();

  constructor(initial: LanguageDescriptor[] = INITIAL_LANGUAGES) {
    for (const l of initial) this.register(l);
  }

  register(lang: LanguageDescriptor): void {
    this.langs.set(lang.code, lang);
  }

  unregister(code: string): boolean {
    return this.langs.delete(code);
  }

  get(codeOrTag: string): LanguageDescriptor | undefined {
    const code = codeOrTag.split('-')[0]!.toLowerCase();
    return this.langs.get(code);
  }

  list(): LanguageDescriptor[] {
    return [...this.langs.values()];
  }
}
