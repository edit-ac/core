const fail = message => { throw Error(message); };
const demand = (condition, message) => { if (!condition) fail(message); };

// Execute the schema vocabulary used by the checked-in, dependency-free v1 schema.
// Unsupported schema keywords fail closed rather than silently being ignored.
export function validateSchema(value, schema, path = '$') {
  const supported = new Set(['$schema', '$id', 'title', 'type', 'const', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'items', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']);
  for (const keyword of Object.keys(schema)) demand(supported.has(keyword), `unsupported schema keyword ${keyword}`);
  if ('const' in schema) demand(value === schema.const, `${path}: const`);
  if (schema.enum) demand(schema.enum.includes(value), `${path}: enum`);
  if (schema.type) {
    const matches = schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'null' ? value === null : typeof value === schema.type;
    demand(matches, `${path}: type ${schema.type}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength) demand(value.trim().length >= schema.minLength, `${path}: empty string`);
    if (schema.maxLength !== undefined) demand(value.length <= schema.maxLength, `${path}: maxLength`);
    if (schema.pattern) demand(new RegExp(schema.pattern, 'u').test(value), `${path}: pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) demand(value >= schema.minimum, `${path}: minimum`);
    if (schema.maximum !== undefined) demand(value <= schema.maximum, `${path}: maximum`);
  }
  if (Array.isArray(value)) {
    demand(value.length >= (schema.minItems ?? 0), `${path}: minItems`);
    if (schema.maxItems !== undefined) demand(value.length <= schema.maxItems, `${path}: maxItems`);
    if (schema.uniqueItems) demand(new Set(value.map(x => JSON.stringify(x))).size === value.length, `${path}: duplicate array item`);
    value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`));
  } else if (schema.type === 'object') {
    demand(Object.keys(value).length >= (schema.minProperties ?? 0), `${path}: minProperties`);
    if (schema.maxProperties !== undefined) demand(Object.keys(value).length <= schema.maxProperties, `${path}: maxProperties`);
    for (const key of schema.required ?? []) demand(Object.hasOwn(value, key), `${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
      if (property) validateSchema(item, property, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') validateSchema(item, schema.additionalProperties, `${path}.${key}`);
    }
  }
}
