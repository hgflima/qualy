/**
 * User accounts, password hashing, and lightweight session tracking.
 *
 * Nothing in this module persists to disk; everything lives in process
 * memory. The hashing primitives use the Node `crypto` module and are
 * intended for fixture/demo purposes only - do not lift them into a
 * production system without a careful security review.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type UserRole = "owner" | "admin" | "member" | "guest";

export interface UserProfile {
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
  readonly locale: string;
  readonly timezone: string;
}

export interface PasswordHash {
  readonly algorithm: "scrypt-sim" | "sha256-salted";
  readonly salt: string;
  readonly hash: string;
  readonly iterations: number;
}

export interface SessionToken {
  readonly token: string;
  readonly userId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface Session extends SessionToken {
  readonly revokedAt: number | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const USERNAME_REGEX = /^[A-Za-z][A-Za-z0-9_.-]{2,31}$/u;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class DuplicateUserError extends Error {
  constructor(field: "username" | "email", value: string) {
    super(`A user with ${field} '${value}' already exists.`);
    this.name = "DuplicateUserError";
  }
}

export class WeakPasswordError extends Error {
  constructor(reason: string) {
    super(`Weak password: ${reason}`);
    this.name = "WeakPasswordError";
  }
}

export class PasswordHasher {
  private readonly iterations: number;

  constructor(iterations = 4) {
    if (iterations < 1 || iterations > 16) {
      throw new RangeError("iterations must be between 1 and 16.");
    }
    this.iterations = iterations;
  }

  hash(plaintext: string): PasswordHash {
    if (plaintext.length === 0) {
      throw new CredentialError("Password may not be empty.");
    }
    const salt = randomBytes(16).toString("hex");
    const hash = this.derive(plaintext, salt, this.iterations);
    return {
      algorithm: "sha256-salted",
      salt,
      hash,
      iterations: this.iterations,
    };
  }

  verify(plaintext: string, stored: PasswordHash): boolean {
    if (stored.algorithm !== "sha256-salted") {
      return false;
    }
    const candidate = this.derive(plaintext, stored.salt, stored.iterations);
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(stored.hash, "hex");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }

  private derive(plaintext: string, salt: string, iterations: number): string {
    let buffer = Buffer.from(`${salt}::${plaintext}`, "utf8");
    for (let i = 0; i < iterations; i += 1) {
      buffer = createHash("sha256").update(buffer).digest();
    }
    return buffer.toString("hex");
  }
}

let nextSerial = 1;

function nextUserId(): string {
  const serial = nextSerial++;
  return `usr_${serial.toString(36).padStart(6, "0")}`;
}

const DEFAULT_PROFILE: UserProfile = {
  displayName: "",
  bio: "",
  avatarUrl: null,
  locale: "en-US",
  timezone: "UTC",
};

export class User {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly createdAt: number;
  role: UserRole;
  profile: UserProfile;
  passwordHash: PasswordHash;
  emailVerified: boolean;
  active: boolean;
  lastLoginAt: number | null;
  loginAttempts: number;
  lockedUntil: number | null;
  metadata: Record<string, string>;

  constructor(
    username: string,
    email: string,
    passwordHash: PasswordHash,
    role: UserRole = "member",
  ) {
    if (!USERNAME_REGEX.test(username)) {
      throw new CredentialError(`Username '${username}' is not valid.`);
    }
    if (!EMAIL_REGEX.test(email)) {
      throw new CredentialError(`Email '${email}' is not valid.`);
    }
    this.id = nextUserId();
    this.username = username;
    this.email = email.toLowerCase();
    this.passwordHash = passwordHash;
    this.role = role;
    this.createdAt = Date.now();
    this.profile = { ...DEFAULT_PROFILE, displayName: username };
    this.emailVerified = false;
    this.active = true;
    this.lastLoginAt = null;
    this.loginAttempts = 0;
    this.lockedUntil = null;
    this.metadata = {};
  }

  promote(): void {
    switch (this.role) {
      case "guest":
        this.role = "member";
        break;
      case "member":
        this.role = "admin";
        break;
      case "admin":
        this.role = "owner";
        break;
      case "owner":
        break;
    }
  }

  demote(): void {
    switch (this.role) {
      case "owner":
        this.role = "admin";
        break;
      case "admin":
        this.role = "member";
        break;
      case "member":
        this.role = "guest";
        break;
      case "guest":
        break;
    }
  }

  updateProfile(patch: Partial<UserProfile>): void {
    this.profile = { ...this.profile, ...patch };
  }

  setMetadata(key: string, value: string): void {
    this.metadata[key] = value;
  }

  unsetMetadata(key: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(this.metadata, key)) {
      return false;
    }
    delete this.metadata[key];
    return true;
  }

  isLocked(now = Date.now()): boolean {
    if (this.lockedUntil === null) {
      return false;
    }
    return this.lockedUntil > now;
  }

  recordLoginSuccess(now = Date.now()): void {
    this.lastLoginAt = now;
    this.loginAttempts = 0;
    this.lockedUntil = null;
  }

  recordLoginFailure(maxAttempts = 5, lockoutMs = 15 * 60 * 1000, now = Date.now()): void {
    this.loginAttempts += 1;
    if (this.loginAttempts >= maxAttempts) {
      this.lockedUntil = now + lockoutMs;
    }
  }

  deactivate(): void {
    this.active = false;
  }

  reactivate(): void {
    this.active = true;
    this.lockedUntil = null;
    this.loginAttempts = 0;
  }

  verifyEmail(): void {
    this.emailVerified = true;
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      username: this.username,
      email: this.email,
      role: this.role,
      profile: this.profile,
      emailVerified: this.emailVerified,
      active: this.active,
      createdAt: this.createdAt,
      lastLoginAt: this.lastLoginAt,
      metadata: this.metadata,
    };
  }
}

export interface CreateUserInput {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly role?: UserRole;
  readonly profile?: Partial<UserProfile>;
  readonly metadata?: Record<string, string>;
}

export interface UpdateUserInput {
  readonly profile?: Partial<UserProfile>;
  readonly role?: UserRole;
  readonly active?: boolean;
  readonly emailVerified?: boolean;
  readonly metadata?: Record<string, string>;
}

export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireDigit: boolean;
  readonly requireSymbol: boolean;
  readonly requireMixedCase: boolean;
  readonly disallowed: readonly string[];
}

const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireDigit: true,
  requireSymbol: true,
  requireMixedCase: true,
  disallowed: ["password", "qwerty", "letmein", "12345678"],
};

export function checkPasswordPolicy(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): void {
  if (password.length < policy.minLength) {
    throw new WeakPasswordError(`Must be at least ${policy.minLength} characters.`);
  }
  if (policy.requireDigit && !/\d/u.test(password)) {
    throw new WeakPasswordError("Must contain at least one digit.");
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/u.test(password)) {
    throw new WeakPasswordError("Must contain at least one symbol.");
  }
  if (policy.requireMixedCase && (!/[a-z]/u.test(password) || !/[A-Z]/u.test(password))) {
    throw new WeakPasswordError("Must contain both lowercase and uppercase letters.");
  }
  const lower = password.toLowerCase();
  for (const banned of policy.disallowed) {
    if (lower.includes(banned)) {
      throw new WeakPasswordError(`Must not contain disallowed substring: ${banned}`);
    }
  }
}

export class UserRepository {
  private readonly hasher: PasswordHasher;
  private readonly policy: PasswordPolicy;
  private readonly users: Map<string, User>;
  private readonly byUsername: Map<string, string>;
  private readonly byEmail: Map<string, string>;
  private readonly sessions: Map<string, Session>;
  private readonly sessionsByUser: Map<string, Set<string>>;

  constructor(hasher: PasswordHasher = new PasswordHasher(), policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY) {
    this.hasher = hasher;
    this.policy = policy;
    this.users = new Map();
    this.byUsername = new Map();
    this.byEmail = new Map();
    this.sessions = new Map();
    this.sessionsByUser = new Map();
  }

  createUser(input: CreateUserInput): User {
    const usernameKey = input.username.toLowerCase();
    const emailKey = input.email.toLowerCase();
    if (this.byUsername.has(usernameKey)) {
      throw new DuplicateUserError("username", input.username);
    }
    if (this.byEmail.has(emailKey)) {
      throw new DuplicateUserError("email", input.email);
    }
    checkPasswordPolicy(input.password, this.policy);
    const passwordHash = this.hasher.hash(input.password);
    const user = new User(input.username, input.email, passwordHash, input.role ?? "member");
    if (input.profile !== undefined) {
      user.updateProfile(input.profile);
    }
    if (input.metadata !== undefined) {
      for (const key of Object.keys(input.metadata)) {
        user.setMetadata(key, input.metadata[key]!);
      }
    }
    this.users.set(user.id, user);
    this.byUsername.set(usernameKey, user.id);
    this.byEmail.set(emailKey, user.id);
    return user;
  }

  updateUser(userId: string, input: UpdateUserInput): User {
    const user = this.requireUser(userId);
    if (input.profile !== undefined) {
      user.updateProfile(input.profile);
    }
    if (input.role !== undefined) {
      user.role = input.role;
    }
    if (input.active !== undefined) {
      if (input.active) {
        user.reactivate();
      } else {
        user.deactivate();
      }
    }
    if (input.emailVerified === true) {
      user.verifyEmail();
    }
    if (input.metadata !== undefined) {
      for (const key of Object.keys(input.metadata)) {
        user.setMetadata(key, input.metadata[key]!);
      }
    }
    return user;
  }

  changePassword(userId: string, currentPassword: string, newPassword: string): void {
    const user = this.requireUser(userId);
    if (!this.hasher.verify(currentPassword, user.passwordHash)) {
      throw new CredentialError("Current password does not match.");
    }
    checkPasswordPolicy(newPassword, this.policy);
    user.passwordHash = this.hasher.hash(newPassword);
    this.revokeAllSessions(userId);
  }

  resetPassword(userId: string, newPassword: string): void {
    const user = this.requireUser(userId);
    checkPasswordPolicy(newPassword, this.policy);
    user.passwordHash = this.hasher.hash(newPassword);
    user.loginAttempts = 0;
    user.lockedUntil = null;
    this.revokeAllSessions(userId);
  }

  deleteUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (user === undefined) {
      return false;
    }
    this.users.delete(userId);
    this.byUsername.delete(user.username.toLowerCase());
    this.byEmail.delete(user.email);
    this.revokeAllSessions(userId);
    return true;
  }

  getUser(userId: string): User | null {
    return this.users.get(userId) ?? null;
  }

  requireUser(userId: string): User {
    const user = this.users.get(userId);
    if (user === undefined) {
      throw new CredentialError(`Unknown user: ${userId}`);
    }
    return user;
  }

  findByUsername(username: string): User | null {
    const userId = this.byUsername.get(username.toLowerCase());
    if (userId === undefined) {
      return null;
    }
    return this.users.get(userId) ?? null;
  }

  findByEmail(email: string): User | null {
    const userId = this.byEmail.get(email.toLowerCase());
    if (userId === undefined) {
      return null;
    }
    return this.users.get(userId) ?? null;
  }

  listUsers(filter: { readonly role?: UserRole; readonly active?: boolean } = {}): readonly User[] {
    const out: User[] = [];
    for (const user of this.users.values()) {
      if (filter.role !== undefined && user.role !== filter.role) {
        continue;
      }
      if (filter.active !== undefined && user.active !== filter.active) {
        continue;
      }
      out.push(user);
    }
    return out;
  }

  count(filter: { readonly role?: UserRole; readonly active?: boolean } = {}): number {
    return this.listUsers(filter).length;
  }

  authenticate(usernameOrEmail: string, password: string, context: {
    readonly ip?: string | null;
    readonly userAgent?: string | null;
    readonly ttlMs?: number;
  } = {}): { readonly user: User; readonly session: Session } {
    const candidate =
      this.findByUsername(usernameOrEmail) ?? this.findByEmail(usernameOrEmail);
    if (candidate === null) {
      throw new CredentialError("Invalid credentials.");
    }
    if (!candidate.active) {
      throw new CredentialError("Account is deactivated.");
    }
    if (candidate.isLocked()) {
      throw new CredentialError("Account is locked, try again later.");
    }
    const ok = this.hasher.verify(password, candidate.passwordHash);
    if (!ok) {
      candidate.recordLoginFailure();
      throw new CredentialError("Invalid credentials.");
    }
    candidate.recordLoginSuccess();
    const session = this.issueSession(candidate.id, context);
    return { user: candidate, session };
  }

  issueSession(userId: string, context: {
    readonly ip?: string | null;
    readonly userAgent?: string | null;
    readonly ttlMs?: number;
  } = {}): Session {
    this.requireUser(userId);
    const ttl = context.ttlMs ?? 30 * 60 * 1000;
    const now = Date.now();
    const session: Session = {
      token: randomUUID(),
      userId,
      issuedAt: now,
      expiresAt: now + ttl,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      revokedAt: null,
    };
    this.sessions.set(session.token, session);
    let bucket = this.sessionsByUser.get(userId);
    if (bucket === undefined) {
      bucket = new Set();
      this.sessionsByUser.set(userId, bucket);
    }
    bucket.add(session.token);
    return session;
  }

  validateSession(token: string): Session | null {
    const session = this.sessions.get(token);
    if (session === undefined) {
      return null;
    }
    if (session.revokedAt !== null) {
      return null;
    }
    if (Date.now() >= session.expiresAt) {
      return null;
    }
    return session;
  }

  refreshSession(token: string, ttlMs = 30 * 60 * 1000): Session | null {
    const current = this.validateSession(token);
    if (current === null) {
      return null;
    }
    const refreshed: Session = {
      ...current,
      expiresAt: Date.now() + ttlMs,
    };
    this.sessions.set(token, refreshed);
    return refreshed;
  }

  revokeSession(token: string): boolean {
    const session = this.sessions.get(token);
    if (session === undefined) {
      return false;
    }
    if (session.revokedAt !== null) {
      return false;
    }
    const revoked: Session = { ...session, revokedAt: Date.now() };
    this.sessions.set(token, revoked);
    return true;
  }

  revokeAllSessions(userId: string): number {
    const bucket = this.sessionsByUser.get(userId);
    if (bucket === undefined) {
      return 0;
    }
    let count = 0;
    for (const token of bucket) {
      if (this.revokeSession(token)) {
        count += 1;
      }
    }
    return count;
  }

  pruneSessions(now = Date.now()): number {
    let pruned = 0;
    for (const [token, session] of [...this.sessions]) {
      if (session.revokedAt !== null || session.expiresAt <= now) {
        this.sessions.delete(token);
        const bucket = this.sessionsByUser.get(session.userId);
        if (bucket !== undefined) {
          bucket.delete(token);
          if (bucket.size === 0) {
            this.sessionsByUser.delete(session.userId);
          }
        }
        pruned += 1;
      }
    }
    return pruned;
  }

  listSessions(userId: string): readonly Session[] {
    const bucket = this.sessionsByUser.get(userId);
    if (bucket === undefined) {
      return [];
    }
    const out: Session[] = [];
    for (const token of bucket) {
      const session = this.sessions.get(token);
      if (session !== undefined) {
        out.push(session);
      }
    }
    return out;
  }

  exportPublicProfiles(): readonly { readonly id: string; readonly username: string; readonly displayName: string }[] {
    const out: { id: string; username: string; displayName: string }[] = [];
    for (const user of this.users.values()) {
      if (!user.active) {
        continue;
      }
      out.push({
        id: user.id,
        username: user.username,
        displayName: user.profile.displayName,
      });
    }
    out.sort((a, b) => a.username.localeCompare(b.username));
    return out;
  }

  searchByUsernamePrefix(prefix: string, limit = 20): readonly User[] {
    if (prefix.length === 0) {
      return [];
    }
    const lower = prefix.toLowerCase();
    const out: User[] = [];
    for (const user of this.users.values()) {
      if (user.username.toLowerCase().startsWith(lower)) {
        out.push(user);
        if (out.length >= limit) {
          break;
        }
      }
    }
    return out;
  }

  bulkLoad(records: readonly CreateUserInput[]): readonly User[] {
    const created: User[] = [];
    for (const record of records) {
      created.push(this.createUser(record));
    }
    return created;
  }

  size(): number {
    return this.users.size;
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}

/**
 * Build a sample repository pre-loaded with a deterministic set of users.
 * Used by smoke tests that need a non-empty starting state.
 */
export function createSampleRepository(): UserRepository {
  const repo = new UserRepository(new PasswordHasher(2));
  repo.createUser({
    username: "alice",
    email: "alice@example.com",
    password: "Strong-Pass-1",
    role: "admin",
    profile: { displayName: "Alice Example", locale: "pt-BR" },
  });
  repo.createUser({
    username: "bob",
    email: "bob@example.com",
    password: "Strong-Pass-2",
    role: "member",
    profile: { displayName: "Bob Example" },
  });
  repo.createUser({
    username: "carol",
    email: "carol@example.com",
    password: "Strong-Pass-3",
    role: "guest",
  });
  return repo;
}

/**
 * Compute a coarse health summary of a {@link UserRepository}.
 */
export function describeRepository(repo: UserRepository): {
  readonly users: number;
  readonly sessions: number;
  readonly admins: number;
  readonly active: number;
} {
  return {
    users: repo.size(),
    sessions: repo.sessionCount(),
    admins: repo.count({ role: "admin" }),
    active: repo.count({ active: true }),
  };
}

/**
 * Compute a deterministic display label for a user (helpful in UIs).
 */
export function userLabel(user: User): string {
  if (user.profile.displayName.length > 0) {
    return user.profile.displayName;
  }
  return user.username;
}
