import { Calculator } from "./calculator.ts";
import { User } from "./user.ts";
import { MemoryStorage } from "./storage.ts";
import { formatCurrency, parseDateOrNull } from "./utils.ts";

export interface AppConfig {
  readonly currency: string;
  readonly locale: string;
}

const DEFAULT_CONFIG: AppConfig = {
  currency: "BRL",
  locale: "pt-BR",
};

export function bootstrap(config: AppConfig = DEFAULT_CONFIG): void {
  const storage = new MemoryStorage<User>();
  const alice = new User("alice", "alice@example.com");
  const bob = new User("bob", "bob@example.com");
  storage.put(alice.id, alice);
  storage.put(bob.id, bob);

  const calc = new Calculator();
  const total = calc.add(125.5, 49.9);
  const formatted = formatCurrency(total, config.currency, config.locale);

  const since = parseDateOrNull("2026-01-01");
  if (since !== null) {
    console.log(`Bootstrapped at ${since.toISOString()} with total ${formatted}.`);
  }
}

if (process.argv[1]?.endsWith("index.ts")) {
  bootstrap();
}
