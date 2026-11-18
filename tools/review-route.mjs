import process from "node:process";
import { Ajv2020 } from "ajv/dist/2020.js";
import policy from "../config/review-policy.json" with { type: "json" };
import schema from "../schemas/review-policy.v1.schema.json" with { type: "json" };

const validate = new Ajv2020({ strict: true }).compile(schema);
if (!validate(policy)) {
  throw new Error(`Invalid review policy: ${JSON.stringify(validate.errors)}`);
}

const subject = process.argv[2];
const route = Object.entries(policy.subjects).find(([name]) => name === subject)?.[1];
const candidates = Object.entries(policy.routes).find(([name]) => name === route)?.[1];
if (!candidates) {
  throw new Error(`Select a review subject: ${Object.keys(policy.subjects).join(", ")}.`);
}

console.info(JSON.stringify({ subject, route, candidates }, null, 2));
