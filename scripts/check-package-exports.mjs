// Exercise the actual compiled workspace exports. This is a packaging smoke
// check, not evidence that an editor or WASM runtime has been implemented.
for (const name of ["@edit-ac/core", "@edit-ac/web", "@edit-ac/react"]) {
  await import(name);
  console.log(`Imported compiled scaffold: ${name}`);
}
