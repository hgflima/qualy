/**
 * A small expression parser that recognises arithmetic, identifiers, calls,
 * and parenthesised groupings.
 *
 * The parser is intentionally hand-written and recursive-descent so the
 * fixture remains free of generator dependencies. The grammar accepted is:
 *
 *   expr        := comparison
 *   comparison  := additive ( ('==' | '!=' | '<' | '<=' | '>' | '>=') additive )*
 *   additive    := multiplicative ( ('+' | '-') multiplicative )*
 *   multiplicative := unary ( ('*' | '/' | '%') unary )*
 *   unary       := ('+' | '-' | '!') unary | call
 *   call        := primary ( '(' argList? ')' )?
 *   primary     := number | string | identifier | '(' expr ')'
 */

export type TokenKind =
  | "number"
  | "string"
  | "identifier"
  | "operator"
  | "punct"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export class Tokenizer {
  private readonly source: string;
  private offset: number;
  private line: number;
  private column: number;

  constructor(source: string) {
    this.source = source;
    this.offset = 0;
    this.line = 1;
    this.column = 1;
  }

  tokenize(): readonly Token[] {
    const out: Token[] = [];
    while (!this.isEnd()) {
      this.skipWhitespace();
      if (this.isEnd()) {
        break;
      }
      const ch = this.peek();
      if (this.isDigit(ch)) {
        out.push(this.readNumber());
        continue;
      }
      if (ch === '"' || ch === "'") {
        out.push(this.readString(ch));
        continue;
      }
      if (this.isIdentStart(ch)) {
        out.push(this.readIdentifier());
        continue;
      }
      if (this.isOperatorStart(ch)) {
        out.push(this.readOperator());
        continue;
      }
      if (this.isPunctuation(ch)) {
        out.push(this.readPunct());
        continue;
      }
      throw new ParseError(`Unexpected character '${ch}'`, this.offset, this.line, this.column);
    }
    out.push({
      kind: "eof",
      value: "",
      start: this.offset,
      end: this.offset,
      line: this.line,
      column: this.column,
    });
    return out;
  }

  private skipWhitespace(): void {
    while (!this.isEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t") {
        this.advance();
        continue;
      }
      if (ch === "\n") {
        this.advance();
        continue;
      }
      if (ch === "\r") {
        this.advance();
        continue;
      }
      if (ch === "#") {
        while (!this.isEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }
      break;
    }
  }

  private readNumber(): Token {
    const start = this.offset;
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";
    while (!this.isEnd() && this.isDigit(this.peek())) {
      value += this.peek();
      this.advance();
    }
    if (!this.isEnd() && this.peek() === ".") {
      value += ".";
      this.advance();
      while (!this.isEnd() && this.isDigit(this.peek())) {
        value += this.peek();
        this.advance();
      }
    }
    if (!this.isEnd() && (this.peek() === "e" || this.peek() === "E")) {
      value += this.peek();
      this.advance();
      if (!this.isEnd() && (this.peek() === "+" || this.peek() === "-")) {
        value += this.peek();
        this.advance();
      }
      while (!this.isEnd() && this.isDigit(this.peek())) {
        value += this.peek();
        this.advance();
      }
    }
    return {
      kind: "number",
      value,
      start,
      end: this.offset,
      line: startLine,
      column: startColumn,
    };
  }

  private readString(quote: string): Token {
    const start = this.offset;
    const startLine = this.line;
    const startColumn = this.column;
    this.advance();
    let value = "";
    while (!this.isEnd() && this.peek() !== quote) {
      if (this.peek() === "\\") {
        this.advance();
        if (this.isEnd()) {
          break;
        }
        const escaped = this.peek();
        if (escaped === "n") {
          value += "\n";
        } else if (escaped === "t") {
          value += "\t";
        } else if (escaped === "r") {
          value += "\r";
        } else {
          value += escaped;
        }
        this.advance();
        continue;
      }
      value += this.peek();
      this.advance();
    }
    if (this.isEnd()) {
      throw new ParseError("Unterminated string literal", start, startLine, startColumn);
    }
    this.advance();
    return {
      kind: "string",
      value,
      start,
      end: this.offset,
      line: startLine,
      column: startColumn,
    };
  }

  private readIdentifier(): Token {
    const start = this.offset;
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";
    while (!this.isEnd() && this.isIdentContinue(this.peek())) {
      value += this.peek();
      this.advance();
    }
    return {
      kind: "identifier",
      value,
      start,
      end: this.offset,
      line: startLine,
      column: startColumn,
    };
  }

  private readOperator(): Token {
    const start = this.offset;
    const startLine = this.line;
    const startColumn = this.column;
    const first = this.peek();
    this.advance();
    const second = this.isEnd() ? "" : this.peek();
    let value = first;
    const twoChar = `${first}${second}`;
    if (
      twoChar === "==" ||
      twoChar === "!=" ||
      twoChar === "<=" ||
      twoChar === ">=" ||
      twoChar === "&&" ||
      twoChar === "||"
    ) {
      value = twoChar;
      this.advance();
    }
    return {
      kind: "operator",
      value,
      start,
      end: this.offset,
      line: startLine,
      column: startColumn,
    };
  }

  private readPunct(): Token {
    const start = this.offset;
    const startLine = this.line;
    const startColumn = this.column;
    const value = this.peek();
    this.advance();
    return {
      kind: "punct",
      value,
      start,
      end: this.offset,
      line: startLine,
      column: startColumn,
    };
  }

  private isEnd(): boolean {
    return this.offset >= this.source.length;
  }

  private peek(): string {
    return this.source.charAt(this.offset);
  }

  private advance(): void {
    const ch = this.source.charAt(this.offset);
    this.offset += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdentContinue(ch: string): boolean {
    return this.isIdentStart(ch) || this.isDigit(ch);
  }

  private isOperatorStart(ch: string): boolean {
    return (
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "%" ||
      ch === "<" ||
      ch === ">" ||
      ch === "=" ||
      ch === "!" ||
      ch === "&" ||
      ch === "|"
    );
  }

  private isPunctuation(ch: string): boolean {
    return ch === "(" || ch === ")" || ch === "," || ch === ";";
  }
}

export type ExpressionKind =
  | "literal"
  | "identifier"
  | "binary"
  | "unary"
  | "call";

export interface BaseExpression {
  readonly kind: ExpressionKind;
  readonly start: number;
  readonly end: number;
}

export interface LiteralExpression extends BaseExpression {
  readonly kind: "literal";
  readonly value: number | string | boolean | null;
}

export interface IdentifierExpression extends BaseExpression {
  readonly kind: "identifier";
  readonly name: string;
}

export interface BinaryExpression extends BaseExpression {
  readonly kind: "binary";
  readonly operator: string;
  readonly left: Expression;
  readonly right: Expression;
}

export interface UnaryExpression extends BaseExpression {
  readonly kind: "unary";
  readonly operator: string;
  readonly operand: Expression;
}

export interface CallExpression extends BaseExpression {
  readonly kind: "call";
  readonly callee: Expression;
  readonly args: readonly Expression[];
}

export type Expression =
  | LiteralExpression
  | IdentifierExpression
  | BinaryExpression
  | UnaryExpression
  | CallExpression;

export class ParseError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, offset: number, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "ParseError";
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export class Parser {
  private readonly tokens: readonly Token[];
  private cursor: number;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
    this.cursor = 0;
  }

  parse(): Expression {
    const expr = this.parseExpression();
    const next = this.peek();
    if (next.kind !== "eof") {
      throw new ParseError(`Unexpected trailing token '${next.value}'`, next.start, next.line, next.column);
    }
    return expr;
  }

  parseExpression(): Expression {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): Expression {
    let left = this.parseLogicalAnd();
    while (this.matchOperator("||")) {
      const operator = this.previous().value;
      const right = this.parseLogicalAnd();
      left = {
        kind: "binary",
        operator,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseLogicalAnd(): Expression {
    let left = this.parseComparison();
    while (this.matchOperator("&&")) {
      const operator = this.previous().value;
      const right = this.parseComparison();
      left = {
        kind: "binary",
        operator,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseComparison(): Expression {
    let left = this.parseAdditive();
    while (this.matchOperator("==", "!=", "<", "<=", ">", ">=")) {
      const operator = this.previous().value;
      const right = this.parseAdditive();
      left = {
        kind: "binary",
        operator,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();
    while (this.matchOperator("+", "-")) {
      const operator = this.previous().value;
      const right = this.parseMultiplicative();
      left = {
        kind: "binary",
        operator,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parseUnary();
    while (this.matchOperator("*", "/", "%")) {
      const operator = this.previous().value;
      const right = this.parseUnary();
      left = {
        kind: "binary",
        operator,
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.matchOperator("+", "-", "!")) {
      const operatorToken = this.previous();
      const operand = this.parseUnary();
      return {
        kind: "unary",
        operator: operatorToken.value,
        operand,
        start: operatorToken.start,
        end: operand.end,
      };
    }
    return this.parseCall();
  }

  private parseCall(): Expression {
    let expr = this.parsePrimary();
    while (this.matchPunct("(")) {
      const args: Expression[] = [];
      if (!this.checkPunct(")")) {
        args.push(this.parseExpression());
        while (this.matchPunct(",")) {
          args.push(this.parseExpression());
        }
      }
      const closing = this.consumePunct(")", "Expected ')' after argument list.");
      expr = {
        kind: "call",
        callee: expr,
        args,
        start: expr.start,
        end: closing.end,
      };
    }
    return expr;
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    if (token.kind === "number") {
      this.advance();
      return {
        kind: "literal",
        value: Number(token.value),
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "string") {
      this.advance();
      return {
        kind: "literal",
        value: token.value,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "identifier") {
      this.advance();
      if (token.value === "true" || token.value === "false") {
        return {
          kind: "literal",
          value: token.value === "true",
          start: token.start,
          end: token.end,
        };
      }
      if (token.value === "null") {
        return {
          kind: "literal",
          value: null,
          start: token.start,
          end: token.end,
        };
      }
      return {
        kind: "identifier",
        name: token.value,
        start: token.start,
        end: token.end,
      };
    }
    if (token.kind === "punct" && token.value === "(") {
      this.advance();
      const expr = this.parseExpression();
      this.consumePunct(")", "Expected ')' after grouped expression.");
      return expr;
    }
    throw new ParseError(`Unexpected token '${token.value}'`, token.start, token.line, token.column);
  }

  private peek(): Token {
    return this.tokens[this.cursor]!;
  }

  private previous(): Token {
    return this.tokens[this.cursor - 1]!;
  }

  private advance(): Token {
    const current = this.peek();
    if (current.kind !== "eof") {
      this.cursor += 1;
    }
    return current;
  }

  private matchOperator(...values: readonly string[]): boolean {
    const token = this.peek();
    if (token.kind !== "operator") {
      return false;
    }
    for (const value of values) {
      if (token.value === value) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private checkPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === "punct" && token.value === value;
  }

  private consumePunct(value: string, message: string): Token {
    const token = this.peek();
    if (token.kind === "punct" && token.value === value) {
      this.advance();
      return token;
    }
    throw new ParseError(message, token.start, token.line, token.column);
  }
}

/**
 * Convenience helper that goes from source string straight to an AST.
 */
export function parse(source: string): Expression {
  const tokens = new Tokenizer(source).tokenize();
  return new Parser(tokens).parse();
}

/**
 * Pretty-print an AST as a Lisp-style s-expression.
 */
export function printExpression(expr: Expression): string {
  switch (expr.kind) {
    case "literal":
      if (typeof expr.value === "string") {
        return JSON.stringify(expr.value);
      }
      return String(expr.value);
    case "identifier":
      return expr.name;
    case "unary":
      return `(${expr.operator} ${printExpression(expr.operand)})`;
    case "binary":
      return `(${expr.operator} ${printExpression(expr.left)} ${printExpression(expr.right)})`;
    case "call": {
      const args = expr.args.map(printExpression).join(" ");
      return `(call ${printExpression(expr.callee)}${args.length === 0 ? "" : ` ${args}`})`;
    }
    default: {
      const exhaustive: never = expr;
      return String(exhaustive);
    }
  }
}

/**
 * Walk an AST and invoke the visitor on every node, depth first.
 */
export function walk(expr: Expression, visit: (node: Expression) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "binary":
      walk(expr.left, visit);
      walk(expr.right, visit);
      break;
    case "unary":
      walk(expr.operand, visit);
      break;
    case "call":
      walk(expr.callee, visit);
      for (const arg of expr.args) {
        walk(arg, visit);
      }
      break;
    case "literal":
    case "identifier":
      break;
    default:
      break;
  }
}

/**
 * Collect every identifier name referenced in an expression tree.
 */
export function collectIdentifiers(expr: Expression): readonly string[] {
  const names = new Set<string>();
  walk(expr, (node) => {
    if (node.kind === "identifier") {
      names.add(node.name);
    }
  });
  return [...names];
}

/**
 * Simple constant folder. Reduces literal arithmetic at parse time.
 */
export function constantFold(expr: Expression): Expression {
  switch (expr.kind) {
    case "binary": {
      const left = constantFold(expr.left);
      const right = constantFold(expr.right);
      if (left.kind === "literal" && right.kind === "literal") {
        const folded = applyBinary(expr.operator, left.value, right.value);
        if (folded.ok) {
          return {
            kind: "literal",
            value: folded.value,
            start: expr.start,
            end: expr.end,
          };
        }
      }
      return { ...expr, left, right };
    }
    case "unary": {
      const operand = constantFold(expr.operand);
      if (operand.kind === "literal") {
        const folded = applyUnary(expr.operator, operand.value);
        if (folded.ok) {
          return {
            kind: "literal",
            value: folded.value,
            start: expr.start,
            end: expr.end,
          };
        }
      }
      return { ...expr, operand };
    }
    case "call": {
      const callee = constantFold(expr.callee);
      const args = expr.args.map(constantFold);
      return { ...expr, callee, args };
    }
    case "literal":
    case "identifier":
      return expr;
    default:
      return expr;
  }
}

function applyBinary(
  operator: string,
  left: LiteralExpression["value"],
  right: LiteralExpression["value"],
): { ok: true; value: LiteralExpression["value"] } | { ok: false } {
  if (typeof left === "number" && typeof right === "number") {
    switch (operator) {
      case "+":
        return { ok: true, value: left + right };
      case "-":
        return { ok: true, value: left - right };
      case "*":
        return { ok: true, value: left * right };
      case "/":
        if (right === 0) {
          return { ok: false };
        }
        return { ok: true, value: left / right };
      case "%":
        if (right === 0) {
          return { ok: false };
        }
        return { ok: true, value: left % right };
      case "==":
        return { ok: true, value: left === right };
      case "!=":
        return { ok: true, value: left !== right };
      case "<":
        return { ok: true, value: left < right };
      case "<=":
        return { ok: true, value: left <= right };
      case ">":
        return { ok: true, value: left > right };
      case ">=":
        return { ok: true, value: left >= right };
      default:
        return { ok: false };
    }
  }
  if (typeof left === "string" && typeof right === "string" && operator === "+") {
    return { ok: true, value: left + right };
  }
  return { ok: false };
}

function applyUnary(
  operator: string,
  operand: LiteralExpression["value"],
): { ok: true; value: LiteralExpression["value"] } | { ok: false } {
  if (typeof operand === "number") {
    if (operator === "-") {
      return { ok: true, value: -operand };
    }
    if (operator === "+") {
      return { ok: true, value: operand };
    }
  }
  if (typeof operand === "boolean" && operator === "!") {
    return { ok: true, value: !operand };
  }
  return { ok: false };
}
