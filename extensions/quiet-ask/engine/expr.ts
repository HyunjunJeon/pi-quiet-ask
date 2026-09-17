/**
 * The condition language for pack rules: a fuzzy `if` over Jev answers.
 *
 *   destructive >= vars.destructive
 *   impact >= 2.5 and impact.confidence >= 0.5
 *   failure_class == "transient" and not is_error
 *   intent.p.debug > 0.4 or intent == "debug"
 *
 * Grammar (lowest precedence first):
 *
 *   expr := or
 *   or   := and ("or" and)*
 *   and  := not ("and" not)*
 *   not  := "not" not | cmp
 *   cmp  := value (("==" | "!=" | ">=" | "<=" | ">" | "<") value)?
 *   value:= number | string | true | false | path | "(" expr ")"
 *   path := ident ("." ident)*
 *
 * Paths resolve against a scope object. A bare answer id resolves to its
 * headline value (noul probability, choice label, or score), so
 * `destructive >= 0.9` and `intent == "debug"` read naturally; the full
 * answer is still reachable as `destructive.noul`, `intent.confidence`,
 * `intent.p.debug`, `impact.score`.
 *
 * The evaluator is total: unknown paths are `undefined`, comparisons with
 * `undefined` are false, and there is no way to call code. Parsing happens
 * once per rule at pack load; evaluation is a tree walk.
 */

export type Scope = Record<string, unknown>;

type Token =
	| { kind: "num"; value: number }
	| { kind: "str"; value: string }
	| { kind: "ident"; value: string }
	| { kind: "op"; value: string }
	| { kind: "lparen" }
	| { kind: "rparen" }
	| { kind: "end" };

export type Expr =
	| { kind: "lit"; value: number | string | boolean }
	| { kind: "path"; path: string[] }
	| { kind: "not"; expr: Expr }
	| { kind: "and" | "or"; left: Expr; right: Expr }
	| { kind: "cmp"; op: string; left: Expr; right: Expr };

export class ExprError extends Error {}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (/\s/.test(ch)) {
			i += 1;
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "lparen" });
			i += 1;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rparen" });
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const end = source.indexOf(ch, i + 1);
			if (end < 0) throw new ExprError(`unterminated string at ${i} in "${source}"`);
			tokens.push({ kind: "str", value: source.slice(i + 1, end) });
			i = end + 1;
			continue;
		}
		const two = source.slice(i, i + 2);
		if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
			tokens.push({ kind: "op", value: two });
			i += 2;
			continue;
		}
		if (ch === ">" || ch === "<") {
			tokens.push({ kind: "op", value: ch });
			i += 1;
			continue;
		}
		const num = /^-?\d+(\.\d+)?/.exec(source.slice(i));
		if (num) {
			tokens.push({ kind: "num", value: Number(num[0]) });
			i += num[0].length;
			continue;
		}
		const ident = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*/.exec(source.slice(i));
		if (ident) {
			tokens.push({ kind: "ident", value: ident[0] });
			i += ident[0].length;
			continue;
		}
		throw new ExprError(`unexpected character "${ch}" at ${i} in "${source}"`);
	}
	tokens.push({ kind: "end" });
	return tokens;
}

class Parser {
	private pos = 0;
	private readonly tokens: Token[];
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
		this.tokens = tokenize(source);
	}

	parse(): Expr {
		const expr = this.or();
		if (this.peek().kind !== "end") throw new ExprError(`unexpected token after expression in "${this.source}"`);
		return expr;
	}

	private peek(): Token {
		return this.tokens[this.pos];
	}

	private next(): Token {
		const token = this.tokens[this.pos];
		this.pos += 1;
		return token;
	}

	private isKeyword(word: string): boolean {
		const token = this.peek();
		return token.kind === "ident" && token.value === word;
	}

	private or(): Expr {
		let left = this.and();
		while (this.isKeyword("or")) {
			this.next();
			left = { kind: "or", left, right: this.and() };
		}
		return left;
	}

	private and(): Expr {
		let left = this.not();
		while (this.isKeyword("and")) {
			this.next();
			left = { kind: "and", left, right: this.not() };
		}
		return left;
	}

	private not(): Expr {
		if (this.isKeyword("not")) {
			this.next();
			return { kind: "not", expr: this.not() };
		}
		return this.cmp();
	}

	private cmp(): Expr {
		const left = this.value();
		const token = this.peek();
		if (token.kind === "op") {
			this.next();
			return { kind: "cmp", op: token.value, left, right: this.value() };
		}
		return left;
	}

	private value(): Expr {
		const token = this.next();
		switch (token.kind) {
			case "num":
				return { kind: "lit", value: token.value };
			case "str":
				return { kind: "lit", value: token.value };
			case "ident":
				if (token.value === "true") return { kind: "lit", value: true };
				if (token.value === "false") return { kind: "lit", value: false };
				return { kind: "path", path: token.value.split(".") };
			case "lparen": {
				const inner = this.or();
				if (this.next().kind !== "rparen") throw new ExprError(`missing ")" in "${this.source}"`);
				return inner;
			}
			default:
				throw new ExprError(`unexpected end of expression in "${this.source}"`);
		}
	}
}

export function parseExpr(source: string): Expr {
	return new Parser(source).parse();
}

/** Look up a dotted path; a bare object with a `value` field yields that field. */
export function resolvePath(scope: Scope, path: readonly string[]): unknown {
	let current: unknown = scope;
	for (const segment of path) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	if (current && typeof current === "object" && "value" in (current as Record<string, unknown>)) {
		return (current as Record<string, unknown>).value;
	}
	return current;
}

function truthy(value: unknown): boolean {
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (typeof value === "string") return value.length > 0;
	return Boolean(value);
}

function compare(op: string, left: unknown, right: unknown): boolean {
	if (op === "==") return left === right;
	if (op === "!=") return left !== right;
	if (typeof left !== "number" || typeof right !== "number") return false;
	switch (op) {
		case ">=":
			return left >= right;
		case "<=":
			return left <= right;
		case ">":
			return left > right;
		case "<":
			return left < right;
		default:
			return false;
	}
}

export function evaluate(expr: Expr, scope: Scope): unknown {
	switch (expr.kind) {
		case "lit":
			return expr.value;
		case "path":
			return resolvePath(scope, expr.path);
		case "not":
			return !truthy(evaluate(expr.expr, scope));
		case "and":
			return truthy(evaluate(expr.left, scope)) && truthy(evaluate(expr.right, scope));
		case "or":
			return truthy(evaluate(expr.left, scope)) || truthy(evaluate(expr.right, scope));
		case "cmp":
			return compare(expr.op, evaluate(expr.left, scope), evaluate(expr.right, scope));
	}
}

export function test(expr: Expr, scope: Scope): boolean {
	return truthy(evaluate(expr, scope));
}

/**
 * `{path}` interpolation for messages. Numbers are printed with two
 * decimals, arrays joined with ", ", objects as JSON, unknowns as "?".
 */
export function render(template: string, scope: Scope): string {
	return template.replace(/\{([A-Za-z_$][A-Za-z0-9_$.]*)\}/g, (_match, path: string) => {
		const value = resolvePath(scope, path.split("."));
		if (value === undefined || value === null) return "?";
		if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
		if (Array.isArray(value)) return value.map(String).join(", ");
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	});
}
