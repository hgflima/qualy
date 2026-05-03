/**
 * Detecta o gerenciador de pacotes do projeto a partir do lockfile presente no
 * diretório alvo. Anchor: PLAN §File layout (`pkg-manager.ts — detecta
 * npm/pnpm/yarn/bun`) + AGENTS.md ("bun → pnpm → yarn → npm").
 *
 * A detecção é puramente baseada em arquivo — não lê `package.json`, não
 * inspeciona `engines` nem o campo Corepack `packageManager`. Lockfile é o
 * único sinal autoritativo que o projeto efetivamente usou aquele gerenciador
 * (o `packageManager` field pode estar desatualizado ou aspiracional).
 *
 * Ordem de prioridade (primeiro hit vence):
 *   1. bun       — `bun.lock` (textual) ou `bun.lockb` (binário)
 *   2. pnpm      — `pnpm-lock.yaml`
 *   3. yarn      — `yarn.lock`
 *   4. npm       — `package-lock.json` (sinal explícito) OU fall-through default
 *
 * `source` distingue "achei lock do npm" de "nada encontrado, assumindo npm" —
 * útil para o comando `status` e para mensagens de erro.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type DetectionSource =
  | "bun.lock"
  | "bun.lockb"
  | "pnpm-lock.yaml"
  | "yarn.lock"
  | "package-lock.json"
  | "default";

export interface DetectionResult {
  readonly manager: PackageManager;
  readonly source: DetectionSource;
}

export type ExistsFn = (path: string) => boolean;

const defaultExists: ExistsFn = (path) => existsSync(path);

let existsFn: ExistsFn = defaultExists;

/** Test-only seam. Pass `null` to restore the real `fs.existsSync` runner. */
export function setExistsFn(next: ExistsFn | null): void {
  existsFn = next ?? defaultExists;
}

/**
 * Ordem de checagem deve refletir a prioridade documentada acima. `bun.lock`
 * (textual) ganhou prioridade sobre `bun.lockb` (binário) porque o textual é
 * o formato preferido pelo Bun moderno e tem precedência quando ambos
 * coexistirem em um repo migrando.
 */
const PROBES: readonly { file: string; manager: PackageManager; source: DetectionSource }[] = [
  { file: "bun.lock", manager: "bun", source: "bun.lock" },
  { file: "bun.lockb", manager: "bun", source: "bun.lockb" },
  { file: "pnpm-lock.yaml", manager: "pnpm", source: "pnpm-lock.yaml" },
  { file: "yarn.lock", manager: "yarn", source: "yarn.lock" },
  { file: "package-lock.json", manager: "npm", source: "package-lock.json" },
];

/**
 * Detecta o gerenciador de pacotes em `cwd`. Sempre retorna um resultado —
 * se nenhum lockfile for encontrado, devolve `{ manager: "npm", source:
 * "default" }`. Esse comportamento é intencional: scripts a jusante
 * (`install-deps`) precisam de um padrão executável, e `npm` é universalmente
 * disponível em ambientes Node.
 */
export function detectPackageManager(cwd: string): DetectionResult {
  for (const probe of PROBES) {
    if (existsFn(join(cwd, probe.file))) {
      return { manager: probe.manager, source: probe.source };
    }
  }
  return { manager: "npm", source: "default" };
}
