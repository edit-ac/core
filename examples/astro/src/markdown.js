export async function markdownOptions(assetUrl = '/markdown.wasm') {
  if (!new URL(location.href).searchParams.has('markdown') && !window.markdownEnabled) return {};
  const [{initMarkdown}, {markdownExtension}] = await Promise.all([import('@edit-ac/markdown'), import('@edit-ac/markdown/web')]);
  return {markdown: markdownExtension(await initMarkdown(assetUrl))};
}
