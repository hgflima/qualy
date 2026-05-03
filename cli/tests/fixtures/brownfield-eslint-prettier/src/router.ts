/**
 * A minimal HTTP-style router with middleware support.
 *
 * The router is transport agnostic - it neither opens sockets nor speaks
 * the wire protocol of HTTP/1.1. Instead, it accepts a {@link RequestContext}
 * and returns a {@link ResponsePayload}, leaving the caller free to wire it
 * up to whatever I/O substrate fits the host environment.
 */

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface RequestContext<B = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: B;
  readonly params: Readonly<Record<string, string>>;
  readonly state: Record<string, unknown>;
  readonly requestId: string;
  readonly receivedAt: number;
}

export interface ResponsePayload<B = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: B;
}

export type RouteHandler<I = unknown, O = unknown> = (
  context: RequestContext<I>,
) => ResponsePayload<O> | Promise<ResponsePayload<O>>;

export type Middleware = (
  context: RequestContext,
  next: () => Promise<ResponsePayload>,
) => ResponsePayload | Promise<ResponsePayload>;

export interface Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly segments: readonly RouteSegment[];
  readonly handler: RouteHandler;
  readonly middlewares: readonly Middleware[];
  readonly name: string | null;
}

interface RouteSegment {
  readonly literal: string | null;
  readonly param: string | null;
  readonly wildcard: boolean;
}

export class RouteNotFoundError extends Error {
  constructor(method: HttpMethod, path: string) {
    super(`No route matches ${method} ${path}`);
    this.name = "RouteNotFoundError";
  }
}

export class MethodNotAllowedError extends Error {
  readonly allowedMethods: readonly HttpMethod[];

  constructor(method: HttpMethod, path: string, allowed: readonly HttpMethod[]) {
    super(`Method ${method} not allowed on ${path}; allowed: ${allowed.join(", ")}`);
    this.name = "MethodNotAllowedError";
    this.allowedMethods = allowed;
  }
}

function compilePattern(pattern: string): readonly RouteSegment[] {
  const trimmed = pattern.replace(/^\//u, "").replace(/\/$/u, "");
  if (trimmed.length === 0) {
    return [];
  }
  const segments: RouteSegment[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "*") {
      segments.push({ literal: null, param: null, wildcard: true });
      continue;
    }
    if (part.startsWith(":")) {
      segments.push({ literal: null, param: part.slice(1), wildcard: false });
      continue;
    }
    segments.push({ literal: part, param: null, wildcard: false });
  }
  return segments;
}

function splitPath(path: string): readonly string[] {
  const trimmed = path.replace(/^\//u, "").replace(/\/$/u, "");
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split("/");
}

function matchSegments(
  segments: readonly RouteSegment[],
  parts: readonly string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  let i = 0;
  let j = 0;
  while (i < segments.length) {
    const segment = segments[i]!;
    if (segment.wildcard) {
      const remaining = parts.slice(j).join("/");
      params["*"] = remaining;
      return params;
    }
    if (j >= parts.length) {
      return null;
    }
    const part = parts[j]!;
    if (segment.literal !== null) {
      if (segment.literal !== part) {
        return null;
      }
    } else if (segment.param !== null) {
      params[segment.param] = decodeURIComponent(part);
    }
    i += 1;
    j += 1;
  }
  if (j !== parts.length) {
    return null;
  }
  return params;
}

let nextRequestSerial = 1;

function generateRequestId(): string {
  const serial = nextRequestSerial++;
  return `req_${Date.now().toString(36)}_${serial.toString(36)}`;
}

export class Router {
  private readonly routes: Route[];
  private readonly globalMiddlewares: Middleware[];
  private readonly notFoundHandler: RouteHandler;
  private readonly errorHandler: (error: unknown, context: RequestContext) => ResponsePayload;

  constructor() {
    this.routes = [];
    this.globalMiddlewares = [];
    this.notFoundHandler = (context) => ({
      status: 404,
      headers: { "content-type": "application/json" },
      body: { error: "not_found", path: context.path } as unknown,
    });
    this.errorHandler = (error, context) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        headers: { "content-type": "application/json" },
        body: { error: "internal_error", message, path: context.path } as unknown,
      };
    };
  }

  use(middleware: Middleware): this {
    this.globalMiddlewares.push(middleware);
    return this;
  }

  on(
    method: HttpMethod,
    pattern: string,
    handler: RouteHandler,
    middlewares: readonly Middleware[] = [],
    name: string | null = null,
  ): this {
    this.routes.push({
      method,
      pattern,
      segments: compilePattern(pattern),
      handler,
      middlewares: [...middlewares],
      name,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("GET", pattern, handler, middlewares);
  }

  post(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("POST", pattern, handler, middlewares);
  }

  put(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("PUT", pattern, handler, middlewares);
  }

  patch(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("PATCH", pattern, handler, middlewares);
  }

  delete(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("DELETE", pattern, handler, middlewares);
  }

  head(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("HEAD", pattern, handler, middlewares);
  }

  options(pattern: string, handler: RouteHandler, middlewares: readonly Middleware[] = []): this {
    return this.on("OPTIONS", pattern, handler, middlewares);
  }

  async handle(input: {
    readonly method: HttpMethod;
    readonly path: string;
    readonly query?: Readonly<Record<string, string | undefined>>;
    readonly headers?: Readonly<Record<string, string | undefined>>;
    readonly body?: unknown;
  }): Promise<ResponsePayload> {
    const parts = splitPath(input.path);
    const candidate = this.lookup(input.method, parts);
    const context: RequestContext = {
      method: input.method,
      path: input.path,
      query: input.query ?? {},
      headers: input.headers ?? {},
      body: input.body,
      params: candidate.params,
      state: {},
      requestId: generateRequestId(),
      receivedAt: Date.now(),
    };
    if (candidate.kind === "match") {
      const stack: Middleware[] = [...this.globalMiddlewares, ...candidate.route.middlewares];
      const finalHandler = candidate.route.handler;
      try {
        return await runMiddlewareChain(stack, context, finalHandler);
      } catch (error) {
        return this.errorHandler(error, context);
      }
    }
    if (candidate.kind === "method-not-allowed") {
      const allowedHeader = candidate.allowed.join(", ");
      return {
        status: 405,
        headers: { allow: allowedHeader, "content-type": "application/json" },
        body: { error: "method_not_allowed", allowed: candidate.allowed } as unknown,
      };
    }
    return this.notFoundHandler(context);
  }

  match(method: HttpMethod, path: string): Route | null {
    const parts = splitPath(path);
    const candidate = this.lookup(method, parts);
    if (candidate.kind === "match") {
      return candidate.route;
    }
    return null;
  }

  routeNames(): readonly string[] {
    const out: string[] = [];
    for (const route of this.routes) {
      if (route.name !== null) {
        out.push(route.name);
      }
    }
    return out;
  }

  routeCount(): number {
    return this.routes.length;
  }

  describe(): readonly { readonly method: HttpMethod; readonly pattern: string; readonly name: string | null }[] {
    return this.routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
      name: route.name,
    }));
  }

  private lookup(
    method: HttpMethod,
    parts: readonly string[],
  ): MatchResult {
    const allowedMethods = new Set<HttpMethod>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (params === null) {
        continue;
      }
      if (route.method === method) {
        return { kind: "match", route, params };
      }
      allowedMethods.add(route.method);
    }
    if (allowedMethods.size > 0) {
      return { kind: "method-not-allowed", allowed: [...allowedMethods] };
    }
    return { kind: "not-found", params: {} };
  }
}

type MatchResult =
  | { kind: "match"; route: Route; params: Record<string, string> }
  | { kind: "method-not-allowed"; allowed: readonly HttpMethod[] }
  | { kind: "not-found"; params: Record<string, string> };

async function runMiddlewareChain(
  stack: readonly Middleware[],
  context: RequestContext,
  finalHandler: RouteHandler,
): Promise<ResponsePayload> {
  let index = -1;
  const dispatch = async (i: number): Promise<ResponsePayload> => {
    if (i <= index) {
      throw new Error("next() called multiple times in a single middleware.");
    }
    index = i;
    if (i >= stack.length) {
      return Promise.resolve(finalHandler(context));
    }
    const middleware = stack[i]!;
    return Promise.resolve(middleware(context, () => dispatch(i + 1)));
  };
  return dispatch(0);
}

/**
 * Build a logging middleware that records each request to the supplied sink.
 */
export function loggerMiddleware(sink: (line: string) => void): Middleware {
  return async (context, next) => {
    const start = Date.now();
    const response = await next();
    const elapsed = Date.now() - start;
    sink(`[${context.requestId}] ${context.method} ${context.path} -> ${response.status} (${elapsed}ms)`);
    return response;
  };
}

/**
 * Build a middleware that injects a default content-type into responses.
 */
export function defaultContentTypeMiddleware(contentType: string): Middleware {
  return async (_context, next) => {
    const response = await next();
    if (response.headers["content-type"] !== undefined) {
      return response;
    }
    return {
      ...response,
      headers: { ...response.headers, "content-type": contentType },
    };
  };
}

/**
 * Build a middleware that wraps a per-request timeout around the chain.
 */
export function timeoutMiddleware(ms: number): Middleware {
  return async (_context, next) => {
    return new Promise<ResponsePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Request timed out after ${ms}ms`));
      }, ms);
      next()
        .then((response) => {
          clearTimeout(timer);
          resolve(response);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  };
}

/**
 * Build a middleware that requires a header to be present and non-empty.
 */
export function requireHeaderMiddleware(header: string, status = 400): Middleware {
  return async (context, next) => {
    const value = context.headers[header.toLowerCase()];
    if (value === undefined || value.length === 0) {
      return {
        status,
        headers: { "content-type": "application/json" },
        body: { error: "missing_header", header } as unknown,
      };
    }
    return next();
  };
}

/**
 * Build a JSON-style success response with the supplied body.
 */
export function jsonOk<T>(body: T, headers: Record<string, string> = {}): ResponsePayload<T> {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    body,
  };
}

/**
 * Build a JSON-style created response with the supplied body.
 */
export function jsonCreated<T>(body: T, location?: string): ResponsePayload<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (location !== undefined) {
    headers["location"] = location;
  }
  return { status: 201, headers, body };
}

/**
 * Build an empty 204 No Content response.
 */
export function noContent(): ResponsePayload<null> {
  return { status: 204, headers: {}, body: null };
}

/**
 * Build a JSON-style error response.
 */
export function jsonError(status: number, message: string, details?: Record<string, unknown>): ResponsePayload {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: { error: message, details: details ?? {} } as unknown,
  };
}

/**
 * Compose multiple middlewares into a single one. Useful for grouping a
 * pipeline that you want to attach to many routes at once.
 */
export function composeMiddlewares(middlewares: readonly Middleware[]): Middleware {
  return async (context, next) => {
    let index = -1;
    const dispatch = async (i: number): Promise<ResponsePayload> => {
      if (i <= index) {
        throw new Error("next() called multiple times in composed middleware.");
      }
      index = i;
      if (i >= middlewares.length) {
        return next();
      }
      const middleware = middlewares[i]!;
      return Promise.resolve(middleware(context, () => dispatch(i + 1)));
    };
    return dispatch(0);
  };
}

/**
 * Mount a sub-router under a path prefix into the parent.
 * Useful for breaking large APIs into small files.
 */
export function mountRouter(parent: Router, prefix: string, child: Router): void {
  for (const route of child.describe()) {
    const composedPattern = combinePrefix(prefix, route.pattern);
    const matched = childRouteFor(child, route.method, route.pattern);
    if (matched === null) {
      continue;
    }
    parent.on(matched.method, composedPattern, matched.handler, matched.middlewares, matched.name);
  }
}

function childRouteFor(child: Router, method: HttpMethod, pattern: string): Route | null {
  const path = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return child.match(method, path);
}

function combinePrefix(prefix: string, suffix: string): string {
  const left = prefix.replace(/\/$/u, "");
  const right = suffix.replace(/^\//u, "");
  if (right.length === 0) {
    return left;
  }
  return `${left}/${right}`;
}

/**
 * Build a CORS middleware that injects the supplied access-control headers.
 */
export function corsMiddleware(options: {
  readonly origin: string;
  readonly methods?: readonly HttpMethod[];
  readonly headers?: readonly string[];
  readonly maxAge?: number;
}): Middleware {
  return async (_context, next) => {
    const response = await next();
    const headers: Record<string, string> = { ...response.headers };
    headers["access-control-allow-origin"] = options.origin;
    if (options.methods !== undefined) {
      headers["access-control-allow-methods"] = options.methods.join(", ");
    }
    if (options.headers !== undefined) {
      headers["access-control-allow-headers"] = options.headers.join(", ");
    }
    if (options.maxAge !== undefined) {
      headers["access-control-max-age"] = String(options.maxAge);
    }
    return { ...response, headers };
  };
}

/**
 * Build a middleware that stamps a per-request identifier into both the
 * request state bag and the outbound response headers.
 */
export function requestIdMiddleware(headerName = "x-request-id"): Middleware {
  return async (context, next) => {
    context.state["requestId"] = context.requestId;
    const response = await next();
    return {
      ...response,
      headers: { ...response.headers, [headerName]: context.requestId },
    };
  };
}

/**
 * Build a tiny demo router suitable for smoke tests.
 */
export function buildDemoRouter(): Router {
  const router = new Router();
  router.use(defaultContentTypeMiddleware("application/json"));
  router.get("/", () => jsonOk({ message: "hello" }));
  router.get("/users/:id", (ctx) => jsonOk({ id: ctx.params.id }));
  router.post("/users", (ctx) => jsonCreated({ created: true, body: ctx.body }, "/users/new"));
  router.delete("/users/:id", () => noContent());
  return router;
}
