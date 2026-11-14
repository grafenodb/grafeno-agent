import type { JsonSchema } from "../model/index.js";

/**
 * Checks arguments against the parts of JSON Schema the agent's tools use:
 * `type`, `properties`, `required`, `enum`, `items` and
 * `additionalProperties: false`. Returns the problems, empty when it fits.
 */
export function validate(value: unknown, schema: JsonSchema, path = "input"): string[] {
  const problems: string[] = [];
  const type = schema.type;

  if (typeof type === "string" && !hasType(value, type)) {
    return [`${path} must be ${article(type)} ${type}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    problems.push(`${path} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (typeof name === "string" && !(name in value))
        problems.push(`${path}.${name} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isObject(childSchema)) {
        problems.push(...validate(child, childSchema, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${name} is not an argument of this tool`);
      }
    }
  }

  if (Array.isArray(value) && isObject(schema.items)) {
    const items = schema.items;
    value.forEach((item, index) => {
      problems.push(...validate(item, items, `${path}[${String(index)}]`));
    });
  }
  return problems;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? "an" : "a";
}
