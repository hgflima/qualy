export type UserRole = "admin" | "member" | "guest";

export interface UserProfile {
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvalidEmailError extends Error {
  constructor(email: string) {
    super(`Invalid email address: ${email}`);
    this.name = "InvalidEmailError";
  }
}

let nextSerial = 1;

function nextId(): string {
  const serial = nextSerial++;
  return `usr_${serial.toString(36).padStart(6, "0")}`;
}

export class User {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly createdAt: number;
  role: UserRole;
  profile: UserProfile;

  constructor(username: string, email: string, role: UserRole = "member") {
    if (!EMAIL_REGEX.test(email)) {
      throw new InvalidEmailError(email);
    }
    this.id = nextId();
    this.username = username;
    this.email = email;
    this.role = role;
    this.createdAt = Date.now();
    this.profile = {
      displayName: username,
      bio: "",
      avatarUrl: null,
    };
  }

  promote(): void {
    if (this.role === "guest") {
      this.role = "member";
    } else if (this.role === "member") {
      this.role = "admin";
    }
  }

  demote(): void {
    if (this.role === "admin") {
      this.role = "member";
    } else if (this.role === "member") {
      this.role = "guest";
    }
  }

  updateProfile(patch: Partial<UserProfile>): void {
    this.profile = { ...this.profile, ...patch };
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      username: this.username,
      email: this.email,
      role: this.role,
      profile: this.profile,
      createdAt: this.createdAt,
    };
  }
}
