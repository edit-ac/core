import type { ExtensionAssetsV1 } from './contract.js';

/** One host manifest/base override. URLs are host configuration, never document data. */
export function extensionAsset(assets: ExtensionAssetsV1 | undefined, key: string, filename: string): string | undefined {
  return assets?.baseURL ? new URL(filename, assets.baseURL).href : assets?.manifest?.[key];
}

/** Indirection keeps absent optional installations out of the baseline bundler graph. */
export async function importExtensionModule<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}
