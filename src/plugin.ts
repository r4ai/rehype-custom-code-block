import merge from "deepmerge";
import type { Element, Root } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import JSON5 from "json5";
import { kebabCase } from "scule";
import type {
  BuiltinLanguage,
  BuiltinTheme,
  CodeOptionsThemes,
  LanguageInput,
} from "shikiji";
import { bundledLanguages } from "shikiji";
import { type Plugin } from "unified";
import { visit } from "unist-util-visit";
import { getMeta, isCodeElement, isPreElement } from "./elements";
import { getLangFromClassNames } from "./lang";
import { getHighlighter } from "./shiki";

export type ShikiOptions = {
  /**
   * Language names to include.
   *
   * @default Object.keys(bundledLanguages)
   */
  langs?: Array<LanguageInput | BuiltinLanguage>;

  /**
   * Extra meta data to pass to the highlighter
   */
  meta?: Record<string, unknown>;
};

export type RehypeCustomCodeOptions = {
  langAssociations?: Record<string, string>;
  ignoreLangs?: string[];
  propsPrefix?: string;
  metaStringPreprocess?: (metaString: string) => string;
  shouldExportCodeAsProps?: boolean;
  shiki?: (ShikiOptions & CodeOptionsThemes<BuiltinTheme>) | false;
};

export const defaultRehypeCustomCodeOptions = (
  options?: RehypeCustomCodeOptions,
) =>
  ({
    shiki: false,
    langAssociations: {},
    ignoreLangs: [],
    propsPrefix: "data",
    shouldExportCodeAsProps: options?.shiki ? false : true,
    metaStringPreprocess: (metaString) => metaString,
  }) satisfies Required<RehypeCustomCodeOptions>;

const defaultShikiOptions: Required<ShikiOptions> = {
  langs: Object.keys(bundledLanguages) as BuiltinLanguage[],
  meta: {},
};

/**
 * convert pre element to highlighted pre element using shiki
 * @param options options
 * @param options.highlighter shiki highlighter
 * @returns unified plugin
 *
 * @example
 * ```ts
 * import { rehypeCustomCode } from "rehype-custom-code";
 *
 * const md = `
 *   \`\`\`javascript title="Hello, World!" {1-5}
 *   console.log("Hello, World!");
 *   \`\`\`
 * `;
 *
 * const html = await unified()
 *   .use(remarkParse)
 *   .use(remarkRehype)
 *   .use(rehypeCustomCode, {
 *     shiki: {
 *       themes: {
 *         light: "github-light",
 *         dark: "one-dark-pro",
 *       },
 *     },
 *   })
 *   .use(rehypeStringify)
 *   .process(md);
 *
 * console.log(html.toString());
 * ```
 */
export const rehypeCustomCode: Plugin<[RehypeCustomCodeOptions?], Root> = (
  _options,
) => {
  const options: Required<RehypeCustomCodeOptions> = {
    ...defaultRehypeCustomCodeOptions(_options),
    ..._options,
    shiki: _options?.shiki
      ? {
          ...defaultShikiOptions,
          ..._options.shiki,
        }
      : false,
  } as const;

  const gettingHighlighter = getHighlighter(options.shiki);

  return async (tree, file) => {
    const highlighter = await gettingHighlighter;

    visit(tree, "element", (preNode, index, parent) => {
      // check if the current node is a block code element
      if (!parent || index == null || !isPreElement(preNode)) return;

      // check if the current pre node has a code element as its child
      const codeNode = preNode.children[0];
      if (!isCodeElement(codeNode) || !codeNode.properties) return;
      const codeText = hastToString(codeNode.children[0]);

      // detect language from class names
      const lang = getLangFromClassNames(
        codeNode.properties.className as string[],
        options.langAssociations,
      );

      // if the language is unknown or ignored, skip
      if (!lang || options.ignoreLangs.includes(lang)) return;

      // get meta data
      const meta = getMeta(codeNode, options.metaStringPreprocess);

      // get new highlighted pre node if `options.shiki` is given, otherwise use the current pre node
      const newPreNode = (() => {
        try {
          if (options.shiki) {
            const fragment = highlighter?.codeToHast(codeText, {
              ...options.shiki,
              lang:
                lang && highlighter.getLoadedLanguages().includes(lang)
                  ? lang
                  : "plaintext",
            });
            return fragment?.children[0] as Element | undefined;
          }
          return preNode;
        } catch {
          file.fail(`failed to highlight code block: ${codeText}`);
          return undefined;
        }
      })();
      if (!isPreElement(newPreNode)) return;

      // merge the current pre node with the new highlighted pre node
      newPreNode.data = merge(preNode.data ?? {}, newPreNode.data ?? {});
      newPreNode.position = preNode.position;
      newPreNode.properties = merge(
        preNode.properties ?? {},
        newPreNode.properties ?? {},
      );

      // set meta data
      newPreNode.properties[getPropsKey(options.propsPrefix, "lang")] = lang;
      if (options.shouldExportCodeAsProps) {
        newPreNode.properties[getPropsKey(options.propsPrefix, "code")] =
          codeText;
      }
      for (const [key, value] of Object.entries(meta)) {
        const propsKey = getPropsKey(options.propsPrefix, key);
        if (Array.isArray(value) || typeof value === "object") {
          newPreNode.properties[propsKey] = JSON5.stringify(value);
        } else {
          newPreNode.properties[propsKey] = String(value);
        }
      }

      // replace the current pre node with the highlighted pre node which is generated by shiki
      parent.children.splice(index, 1, newPreNode as Element);
    });
  };
};

const getPropsKey = (prefix: string, key: string) =>
  `${prefix}-${kebabCase(key)}`;

export default rehypeCustomCode;
