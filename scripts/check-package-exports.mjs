// Import smoke only; sdk-prerequisites.test.mjs exercises the implemented API.
for (const name of ["@edit-ac/core", "@edit-ac/web", "@edit-ac/react", "@edit-ac/astro", "@edit-ac/markdown", "@edit-ac/markdown/web"]) {
  await import(name);
  console.log(`Imported compiled package: ${name}`);
}
