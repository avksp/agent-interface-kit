import { CompilerError } from "./contracts.ts";

export function checkJsonStructure(text: string, depthLimit: number): void {
  let index = 0;

  function whitespace(): void {
    while (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t") index++;
  }

  function accept(character: string): boolean {
    whitespace();
    if (text[index] !== character) return false;
    index++;
    return true;
  }

  function expect(character: string): void {
    if (!accept(character)) throw new SyntaxError("Invalid JSON structure");
  }

  function stringEnd(): number {
    const start = index;
    expect('"');
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') return start;
      if (character === "\\") index++;
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function object(depth: number): void {
    if (accept("}")) return;
    const keys = new Set<string>();
    do {
      whitespace();
      const start = stringEnd();
      const key: unknown = JSON.parse(text.slice(start, index));
      if (typeof key !== "string" || keys.has(key)) throw new SyntaxError("Duplicate or invalid JSON member");
      keys.add(key);
      expect(":");
      value(depth + 1);
    } while (accept(","));
    expect("}");
  }

  function array(depth: number): void {
    if (accept("]")) return;
    do {
      value(depth + 1);
    } while (accept(","));
    expect("]");
  }

  function value(depth: number): void {
    if (depth > depthLimit) throw new CompilerError("INPUT_LIMIT_EXCEEDED");
    whitespace();
    if (accept("{")) object(depth);
    else if (accept("[")) array(depth);
    else if (text[index] === '"') stringEnd();
    else {
      // JSON.parse checks the scalar grammar after the structure has passed.
      const start = index;
      while (index < text.length && !/[\s,\]}]/.test(text.charAt(index))) index++;
      if (index === start) throw new SyntaxError("Missing JSON value");
    }
  }

  value(0);
  whitespace();
  if (index !== text.length) throw new SyntaxError("Extra JSON data");
}
