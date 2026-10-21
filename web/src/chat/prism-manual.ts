/**
 * Imported before prismjs: Prism reads this flag as it loads and then never
 * scans the page on its own. Only highlight.ts decides what gets coloured.
 */
(globalThis as { Prism?: { manual?: boolean } }).Prism = { manual: true };

export {};
