// Shared JSON-Schema subset for local schema tests and live probes.
// Extracted so live probes can live under test/live/ without importing a .test.ts file.

export function validate(schema, value, path = "$", root = schema) {
  const errors = [];
  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

  if (schema.$ref !== undefined) {
    const name = schema.$ref.split("/").pop();
    const def = root.$defs?.[name];
    if (!def) return [`${path}: unresolved ref ${schema.$ref}`];
    errors.push(...validate(def, value, path, root));
  }
  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    const matches = want.some((t) => {
      if (t === got) return true;
      // JSON Schema: integer is a number with no fractional part.
      if (t === "integer" && got === "number" && Number.isInteger(value)) return true;
      return false;
    });
    if (!matches) errors.push(`${path}: expected type ${want.join("|")}, got ${got}`);
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: string does not match ${schema.pattern}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${path}: ${value.length} items < minimum ${schema.minItems}`);
  }
  if (schema.format === "date-time" && typeof value === "string" && Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: not a valid date-time`);
  }
  if (schema.required !== undefined && typeOf(value) === "object") {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${path}: missing required field "${key}"`);
    }
  }
  if (schema.properties !== undefined && typeOf(value) === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`, root));
    }
  }
  if (schema.items !== undefined && typeOf(value) === "array") {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`, root)));
  }
  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) errors.push(...validate(sub, value, path, root));
  }
  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter((sub) => validate(sub, value, path, root).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matched ${passing} of oneOf branches, need exactly 1`);
  }
  if (schema.if !== undefined) {
    const branch = validate(schema.if, value, path, root).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validate(branch, value, path, root));
  }
  if (schema.not !== undefined && validate(schema.not, value, path, root).length === 0) {
    errors.push(`${path}: matched a forbidden schema`);
  }
  return errors;
}

