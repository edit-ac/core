declare const katex: {
  renderToString(source: string, options: {
    output: 'mathml'; displayMode: boolean; trust: false; throwOnError: true;
    strict: 'error'; maxExpand: number; maxSize: number; macros: Record<string, never>; globalGroup: false;
  }): string;
};
export default katex;
