export async function markdownOptions(assetUrl = '/markdown/wasm/editac_markdown_wasm_bg.wasm') {
  if (!new URL(location.href).searchParams.has('markdown') && !new URL(location.href).searchParams.has('formats') && !window.markdownEnabled) return {};
  const [{initMarkdown}, {markdownExtension}] = await Promise.all([import('@edit-ac/markdown'), import('@edit-ac/markdown/web')]);
  return {markdown: markdownExtension(await initMarkdown(assetUrl))};
}
