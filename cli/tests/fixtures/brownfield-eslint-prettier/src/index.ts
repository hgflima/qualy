/**
 * Public surface for the brownfield-eslint-prettier sample package.
 *
 * This barrel file re-exports the most commonly used building blocks so
 * downstream consumers can avoid reaching into deeply nested module paths.
 * The shape of these exports is intentionally stable; renames here are
 * considered breaking changes and require a major version bump.
 */

export {
  Calculator,
  CalculatorConfig,
  CalculatorSnapshot,
  CalculationRecord,
  Operation,
  DivisionByZeroError,
  OverflowError,
  PrecisionError,
} from "./calculator.ts";

export {
  InMemoryStore,
  StorageEntry,
  StoreOptions,
  EvictionStrategy,
  EvictionEvent,
  KeyNotFoundError,
  StoreClosedError,
  TtlExpiredError,
} from "./storage.ts";

export {
  User,
  UserRepository,
  UserRole,
  UserProfile,
  Session,
  SessionToken,
  PasswordHash,
  PasswordHasher,
  CredentialError,
  DuplicateUserError,
  WeakPasswordError,
} from "./users.ts";

export {
  Router,
  Route,
  RouteHandler,
  Middleware,
  RequestContext,
  ResponsePayload,
  HttpMethod,
  RouteNotFoundError,
  MethodNotAllowedError,
} from "./router.ts";

export {
  Tokenizer,
  Token,
  TokenKind,
  Parser,
  ParseError,
  Expression,
  BinaryExpression,
  UnaryExpression,
  LiteralExpression,
  IdentifierExpression,
  CallExpression,
} from "./parser.ts";

export {
  Validator,
  ValidationResult,
  ValidationIssue,
  ValidationContext,
  string,
  number,
  boolean,
  array,
  object,
  optional,
  nullable,
} from "./validator.ts";

export {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercentage,
  parseInteger,
  parseDecimal,
  clamp,
  chunk,
  unique,
  groupBy,
  delay,
  once,
  pick,
  omit,
  deepClone,
  deepEqual,
  isPlainObject,
  toCamelCase,
  toSnakeCase,
  toKebabCase,
  truncate,
  pad,
} from "./utils.ts";
